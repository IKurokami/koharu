import { exec as execCallback, spawn } from 'node:child_process'
import { readdir, access, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execCallback)

async function pathExists(target: string) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function checkNvcc() {
  try {
    await exec('nvcc --version', { env: process.env })
  } catch {
    throw new Error('nvcc not found')
  }
}

function sortVersionsDesc(versions: string[]) {
  return versions.sort((a, b) => {
    const verA = parseInt(a.replace('v', '').replace('.', ''))
    const verB = parseInt(b.replace('v', '').replace('.', ''))
    return verB - verA
  })
}

async function setupCuda() {
  const cudaPath = process.env.CUDA_PATH
  if (cudaPath) {
    const binPath = path.join(cudaPath, 'bin')
    process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH}`
    return
  }

  const cudaRoot = 'C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA'
  const versions = await readdir(cudaRoot).catch(() => [])

  sortVersionsDesc(versions)

  for (const version of versions) {
    if (version.startsWith('v')) {
      const binPath = path.join(cudaRoot, version, 'bin')
      if (await pathExists(binPath)) {
        process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH}`
        process.env.CUDA_PATH = path.join(cudaRoot, version)
        return
      }
    }
  }

  throw new Error(
    'NVCC not found. Please install the CUDA Toolkit from https://developer.nvidia.com/cuda-downloads',
  )
}

async function setupCl() {
  const vsRoots = [
    'C:/Program Files/Microsoft Visual Studio',
    'C:/Program Files (x86)/Microsoft Visual Studio',
  ]
  const editions = ['Community', 'Professional', 'Enterprise', 'BuildTools']

  for (const vsRoot of vsRoots) {
    const vsVersions = await readdir(vsRoot).catch(() => [])

    for (const vsVersion of vsVersions) {
      for (const edition of editions) {
        const vcPath = path.join(vsRoot, vsVersion, edition, 'VC/Tools/MSVC')
        if (await pathExists(vcPath)) {
          const msvcVersions = await readdir(vcPath)
          for (const msvcVersion of msvcVersions) {
            const binPath = path.join(vcPath, msvcVersion, 'bin/Hostx64/x64')
            if (await pathExists(binPath)) {
              process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH}`
              return
            }
          }
        }
      }
    }
  }

  throw new Error(
    'cl.exe not found. Please install Visual Studio with C++ build tools from https://visualstudio.microsoft.com/downloads/',
  )
}

function shouldSetupCuda(args: string[]) {
  if (process.env.KOHARU_SETUP_CUDA === '1') return true
  const featureArgIndex = args.findIndex((arg) => arg === '--features' || arg === '-F')
  const featureValue = featureArgIndex >= 0 ? args[featureArgIndex + 1] : ''
  return args.some((arg) => arg === 'cuda' || arg.includes('cuda')) || featureValue.includes('cuda')
}

async function shouldBundleRunner(source: string, output: string) {
  try {
    const [sourceStat, outputStat] = await Promise.all([stat(source), stat(output)])
    return sourceStat.mtimeMs > outputStat.mtimeMs
  } catch {
    return true
  }
}

async function checkCl() {
  try {
    await exec('where cl.exe', { env: process.env })
  } catch {
    throw new Error('cl.exe not found')
  }
}

async function dev() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    throw new Error('No command provided')
  }

  if (os.type() === 'Windows_NT') {
    if (shouldSetupCuda(args)) {
      // First, try to check if nvcc is available
      await checkNvcc()
        // If not found, try to set up CUDA paths
        .catch(async () => {
          await setupCuda()
          // Check again after setup
          await checkNvcc()
        })
    }

    // Setup cl.exe path only when it is not already available.
    await checkCl().catch(setupCl)
  }

  // Automatically bundle haruneko_runner.ts to haruneko_runner.js to ensure it's up to date for dev and build
  const runnerSource = path.join('scripts', 'haruneko_runner.ts')
  const runnerOutput = path.join('scripts', 'haruneko_runner.js')
  if (await shouldBundleRunner(runnerSource, runnerOutput)) {
    console.log('Bundling haruneko_runner.ts to haruneko_runner.js...')
    try {
      await exec(
        'bun build scripts/haruneko_runner.ts --outfile=scripts/haruneko_runner.js --target=bun',
      )
      console.log('Runner bundled successfully!')
    } catch (err: any) {
      console.error('Failed to bundle runner:', err.message || err)
    }
  }

  const proc = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  })

  proc.on('error', (err) => {
    throw err
  })

  proc.on('exit', (code) => {
    process.exit(code)
  })
}

dev().catch((err) => {
  process.stderr.write(`Error: ${err.message} \n`)
  process.exit(1)
})
