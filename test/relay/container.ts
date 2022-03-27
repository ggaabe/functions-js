import * as fs from 'fs'
import { nanoid } from 'nanoid'
import { GenericContainer, Network, StartedTestContainer, Wait } from 'testcontainers'
import { ExecResult } from 'testcontainers/dist/docker/types'
import { ContentType } from 'allure2-js-commons'
import { attach, log } from '../utils/allure'

/**
 * A Relay contains a running relay container that has a unique ID and two promises:
 * one for the `deno cache` and one for the `deno run` the required function
 */
export class Relay {
  container: StartedTestContainer
  id: string
  execCache: Promise<ExecResult>
  execRun: Promise<ExecResult>
  constructor(
    container: StartedTestContainer,
    id: string,
    execCache: Promise<ExecResult>,
    execRun: Promise<ExecResult>
  ) {
    this.container = container
    this.id = id
    this.execCache = execCache
    this.execRun = execRun
  }
}

/**
 * It starts a docker container with a deno relay, and waits for it to be ready
 * @param {string} slug - the name of the function to deploy
 * @param {string} jwtSecret - the JWT secret to access function
 * @param {string} [denoOrigin=http://localhost:8000] - the origin of the deno server
 * @param {Map<string, string>} env - list of environment variables for deno relay
 * @returns {Promise<Relay>} A Relay object.
 */
export async function runRelay(
  slug: string,
  jwtSecret: string,
  denoOrigin: string = 'http://localhost:8000',
  env?: Map<string, string>
): Promise<Relay> {
  // read function to deploy
  log('read function body')
  const functionBytes = fs.readFileSync('test/functions/' + slug + '.ts', 'utf8')
  attach('function body', functionBytes, ContentType.TEXT)

  // random id for parallel execution
  const id = nanoid(5)

  //create network
  log('add network')
  const network = await new Network({ name: 'supabase_network_' + id }).start()

  // create relay container
  log(`create relay ${slug + '-' + id}`)
  const relay = await new GenericContainer('supabase/deno-relay')
    .withName(slug + '-' + id)
    .withCmd([
      'sh',
      '-c',
      `cat <<'EOF' > /home/deno/${slug}.ts && deno run --allow-all index.ts
` +
        functionBytes +
        `
EOF
`,
    ])
    .withNetworkMode(network.getName())
    .withExposedPorts(8081)
    .withWaitStrategy(Wait.forLogMessage('Listening on http://0.0.0.0:8081'))
    .withStartupTimeout(15000)
    .withReuse()

  // add envs
  env = parseEnv(env, jwtSecret, denoOrigin)
  env && env.forEach((value, key) => relay.withEnv(key, value))

  // start relay and function
  log(`start relay ${slug + '-' + id}`)
  const startedRelay = await relay.start()
  const execCache = startedRelay.exec(['deno', 'cache', `/home/deno/${slug}.ts`])
  const execRun = startedRelay.exec(['deno', 'run', '--allow-all', `/home/deno/${slug}.ts`])

  // wait till function is running
  log(`check function is healthy: ${slug + '-' + id}`)
  for (let ctr = 0; ctr < 30; ctr++) {
    const healthCheck = await startedRelay.exec(['nc', '-z', 'localhost', '8000'])
    if (healthCheck.exitCode == 0) {
      log(`function started to serve: ${slug + '-' + id}`)
      return { container: startedRelay, id, execCache, execRun }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // if function hasn't started, stop container and throw
  log(`function failed to start: ${slug + '-' + id}`)
  startedRelay.stop()
  throw new Error("function haven'start correctly")
}

/**
 * If the JWT_SECRET and DENO_ORIGIN environment is not set, set it
 * @param env - The environment variables.
 * @param {string} jwtSecret - The JWT secret.
 * @param {string} denoOrigin - The origin of the Deno server.
 * @returns {Map<string, string>} - `env` variables map.
 */
function parseEnv(
  env: Map<string, string> | undefined | null,
  jwtSecret: string,
  denoOrigin: string
): Map<string, string> {
  if (env) {
    !env.has('JWT_SECRET') && jwtSecret && env.set('JWT_SECRET', jwtSecret)
    !env.has('DENO_ORIGIN') && denoOrigin && env.set('DENO_ORIGIN', denoOrigin)
  } else {
    env = new Map([
      ['JWT_SECRET', jwtSecret],
      ['DENO_ORIGIN', denoOrigin],
    ])
  }
  return env
}
