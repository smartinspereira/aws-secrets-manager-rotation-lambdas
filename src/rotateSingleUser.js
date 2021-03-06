'use strict'

const aws = require('aws-sdk')
const knex = require('knex')
const secretsManager = new aws.SecretsManager()

const AWSPREVIOUS = 'AWSPREVIOUS'
const AWSPENDING = 'AWSPENDING'
const AWSCURRENT = 'AWSCURRENT'

const log = x => console.log(JSON.stringify({ log: x }, null, 2))

async function rotate(event) {
  log({ event })

  const { SecretId, ClientRequestToken, Step } = event

  const metadata = await secretsManager.describeSecret({ SecretId: SecretId }).promise()
  if (!metadata.RotationEnabled)
    throw new Error(`error::rotate: secret ${SecretId} rotation disabled`)

  const versions = metadata.VersionIdsToStages
  if (!versions[ClientRequestToken])
    throw new Error(`error::rotate: secret ${SecretId} no secret version ${ClientRequestToken}`)

  if (versions[ClientRequestToken].includes(AWSCURRENT))
    log(`secret ${SecretId} version ${ClientRequestToken} stage ${AWSCURRENT}`)
  else if (versions[ClientRequestToken].includes(AWSPENDING)) {
    if (Step === 'createSecret') await createSecret(SecretId, ClientRequestToken)
    else if (Step === 'setSecret') await setSecret(SecretId, ClientRequestToken)
    else if (Step === 'testSecret') await testSecret(SecretId, ClientRequestToken)
    else if (Step === 'finishSecret') await finishSecret(SecretId, ClientRequestToken)
    else throw new Error(`error::rotate: secret ${SecretId} Step ${Step} invalid`)
  } else throw new Error(`error::rotate: secret ${SecretId} version ${ClientRequestToken} stage invalid`)
}

async function createSecret(SecretId, ClientRequestToken) {
  log('createSecret')

  const currentSecret = await getSecret(SecretId, AWSCURRENT)

  try { await getSecret(SecretId, AWSPENDING, ClientRequestToken) }
  catch (error) {
    const password = (await secretsManager.getRandomPassword(
      { PasswordLength: 128, ExcludePunctuation: true }
    ).promise()).RandomPassword

    await secretsManager.putSecretValue(
      {
        SecretId: SecretId,
        ClientRequestToken: ClientRequestToken,
        SecretString: JSON.stringify(
          {
            ...currentSecret,
            ...{ password }
          }
        ),
        VersionStages: [AWSPENDING]
      }
    ).promise()
  }

  log(`secret ${SecretId} version ${ClientRequestToken} stage ${AWSPENDING}`)
}

async function setSecret(SecretId, ClientRequestToken) {
  log('setSecret')

  let dbConnection = null
  try {
    const pendingSecret = await getSecret(SecretId, AWSPENDING, ClientRequestToken)

    log(`using secret ${SecretId} version ${ClientRequestToken} stage ${AWSPENDING}`)

    dbConnection = await getDbConnection(pendingSecret)

    if (!dbConnection) {
      const currentSecret = await getSecret(SecretId, AWSCURRENT)

      log(`using secret ${SecretId} version ${ClientRequestToken} stage ${AWSCURRENT}`)

      dbConnection = await getDbConnection(currentSecret)

      if (!dbConnection) {
        const previousSecret = await getSecret(SecretId, AWSPREVIOUS)

        log(`using secret ${SecretId} version ${ClientRequestToken} stage ${AWSPREVIOUS}`)

        dbConnection = await getDbConnection(previousSecret)

        if (!dbConnection) {
          throw new Error(
            `error::setSecret: secret ${SecretId} stage ${AWSPENDING} && ${AWSCURRENT} && ${AWSPREVIOUS} invalid`
          )
        }
      }

      log('setting password')

      await dbConnection.raw(`alter user "${pendingSecret.username}" with password '${pendingSecret.password}'`)

      log(`secret ${SecretId} rotated`)
    }
    else { log(`secret ${SecretId} version ${ClientRequestToken} stage ${AWSPENDING}`) }
  } finally { if (dbConnection) await dbConnection.destroy() }
}

async function testSecret(SecretId, ClientRequestToken) {
  log('testSecret')

  const pendingSecret = await getSecret(SecretId, AWSPENDING, ClientRequestToken)
  const dbConnection = await getDbConnection(pendingSecret)

  if (dbConnection) {
    try { dbConnection.raw('select now()') }
    finally { await dbConnection.destroy() }

    log(`secret ${SecretId} version ${ClientRequestToken} stage ${AWSPENDING} test success`)
  } else {
    throw new Error(`error::testSecret: secret ${SecretId} version ${ClientRequestToken} stage ${AWSPENDING} test fail`)
  }
}

async function finishSecret(SecretId, ClientRequestToken) {
  log('finishSecret')

  const metadata = await secretsManager.describeSecret({ SecretId: SecretId }).promise()
  let currentVersion = null

  log(metadata.VersionIdsToStages)

  for (const [versionId, stages] of Object.entries(metadata.VersionIdsToStages)) {
    if (stages.includes(AWSCURRENT)) {
      if (versionId === ClientRequestToken) {
        log(`secret ${SecretId} version ${ClientRequestToken} stage ${AWSCURRENT}`)
        return
      }

      currentVersion = versionId
      break
    }
  }

  await secretsManager.updateSecretVersionStage(
    {
      SecretId: SecretId,
      VersionStage: AWSCURRENT,
      MoveToVersionId: ClientRequestToken,
      RemoveFromVersionId: currentVersion
    }
  ).promise()

  log(`secret ${SecretId} version ${ClientRequestToken} stage ${AWSCURRENT}`)
  log((await secretsManager.describeSecret({ SecretId: SecretId }).promise()).VersionIdsToStages)
}

async function getDbConnection(secretDict) {
  log('getDbConnection')

  try {
    const dbConnection = knex(
      {
        client: 'pg',
        connection: {
          host: secretDict.host,
          user: secretDict.username,
          password: secretDict.password,
          database: secretDict.dbname
        }
      }
    )

    log({ dbConnection: await dbConnection.raw('select now()') })

    log('establish db connection success')

    return dbConnection
  } catch (_) {
    log('establish db connection fail')

    return null
  }
}

async function getSecret(SecretId, stage, ClientRequestToken) {
  log('getSecret')

  const secret = JSON.parse(
    (await secretsManager.getSecretValue(
      { SecretId: SecretId, ...(ClientRequestToken ? { VersionId: ClientRequestToken } : {}), VersionStage: stage }
    ).promise()).SecretString
  )

  if (secret.engine !== 'postgres') throw new Error(`error::getSecret: secret ${SecretId} invalid db engine`)

  for (const key of ['host', 'username', 'password']) {
    if (!secret[key]) throw new Error(`error::getSecret: secret ${SecretId} missing key ${key}`)
  }

  return secret
}

exports.rotateSingleUser = rotate
