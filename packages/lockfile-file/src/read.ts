import { promises as fs } from 'fs'
import path from 'path'
import {
  LOCKFILE_VERSION,
  WANTED_LOCKFILE,
} from '@pnpm/constants'
import PnpmError from '@pnpm/error'
import { Lockfile } from '@pnpm/lockfile-types'
import { DEPENDENCIES_FIELDS } from '@pnpm/types'
import comverToSemver from 'comver-to-semver'
import yaml from 'js-yaml'
import semver from 'semver'
import stripBom from 'strip-bom'
import { LockfileBreakingChangeError } from './errors'
import { autofixMergeConflicts, isDiff } from './gitMergeFile'
import logger from './logger'
import { LockfileFile } from './write'
import { getWantedLockfileName } from './lockfileName'
import { getGitBranchLockfileNames } from './gitBranchLockfile'

export async function readCurrentLockfile (
  virtualStoreDir: string,
  opts: {
    wantedVersion?: number
    ignoreIncompatible: boolean
  }
): Promise<Lockfile | null> {
  const lockfilePath = path.join(virtualStoreDir, 'lock.yaml')
  return (await _read(lockfilePath, virtualStoreDir, opts)).lockfile
}

export async function readWantedLockfileAndAutofixConflicts (
  pkgPath: string,
  opts: {
    wantedVersion?: number
    ignoreIncompatible: boolean
    useGitBranchLockfile?: boolean
    mergeGitBranchLockfiles?: boolean
  }
): Promise<{
    lockfile: Lockfile | null
    hadConflicts: boolean
  }> {
  const lockfileNames: string[] = [WANTED_LOCKFILE]
  if (opts.useGitBranchLockfile) {
    const gitBranchLockfileName: string = await getWantedLockfileName(opts)
    if (gitBranchLockfileName !== WANTED_LOCKFILE) {
      lockfileNames.unshift(gitBranchLockfileName)
    }
  }
  let result: { lockfile: Lockfile | null, hadConflicts: boolean } = { lockfile: null, hadConflicts: false }
  for (const lockfileName of lockfileNames) {
    result = await _read(path.join(pkgPath, lockfileName), pkgPath, { ...opts, autofixMergeConflicts: true })
    if (result.lockfile) {
      if (opts.mergeGitBranchLockfiles) {
        result.lockfile = await _mergeGitBranchLockfiles(result.lockfile, pkgPath, pkgPath, opts)
      }
      break
    }
  }
  return result
}

export async function readWantedLockfile (
  pkgPath: string,
  opts: {
    wantedVersion?: number
    ignoreIncompatible: boolean
    useGitBranchLockfile?: boolean
    mergeGitBranchLockfiles?: boolean
  }
): Promise<Lockfile | null> {
  const lockfileNames: string[] = [WANTED_LOCKFILE]
  if (opts.useGitBranchLockfile) {
    const gitBranchLockfileName: string = await getWantedLockfileName(opts)
    if (gitBranchLockfileName !== WANTED_LOCKFILE) {
      lockfileNames.unshift(gitBranchLockfileName)
    }
  }
  let lockfile: Lockfile | null = null
  for (const lockfileName of lockfileNames) {
    lockfile = (await _read(path.join(pkgPath, lockfileName), pkgPath, opts)).lockfile
    if (lockfile) {
      if (opts.mergeGitBranchLockfiles) {
        lockfile = await _mergeGitBranchLockfiles(lockfile, pkgPath, pkgPath, opts)
      }
      break
    }
  }
  return lockfile
}

async function _read (
  lockfilePath: string,
  prefix: string, // only for logging
  opts: {
    autofixMergeConflicts?: boolean
    wantedVersion?: number
    ignoreIncompatible: boolean
  }
): Promise<{
    lockfile: Lockfile | null
    hadConflicts: boolean
  }> {
  let lockfileRawContent
  try {
    lockfileRawContent = stripBom(await fs.readFile(lockfilePath, 'utf8'))
  } catch (err: any) { // eslint-disable-line
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
    return {
      lockfile: null,
      hadConflicts: false,
    }
  }
  let lockfile: LockfileFile
  let hadConflicts!: boolean
  try {
    lockfile = yaml.load(lockfileRawContent) as Lockfile
    hadConflicts = false
  } catch (err: any) { // eslint-disable-line
    if (!opts.autofixMergeConflicts || !isDiff(lockfileRawContent)) {
      throw new PnpmError('BROKEN_LOCKFILE', `The lockfile at "${lockfilePath}" is broken: ${err.message as string}`)
    }
    hadConflicts = true
    lockfile = autofixMergeConflicts(lockfileRawContent)
    logger.info({
      message: `Merge conflict detected in ${WANTED_LOCKFILE} and successfully merged`,
      prefix,
    })
  }
  /* eslint-disable @typescript-eslint/dot-notation */
  if (typeof lockfile?.['specifiers'] !== 'undefined') {
    lockfile.importers = {
      '.': {
        specifiers: lockfile['specifiers'],
        dependenciesMeta: lockfile['dependenciesMeta'],
      },
    }
    delete lockfile.specifiers
    for (const depType of DEPENDENCIES_FIELDS) {
      if (lockfile[depType] != null) {
        lockfile.importers['.'][depType] = lockfile[depType]
        delete lockfile[depType]
      }
    }
  }
  if (lockfile) {
    const lockfileSemver = comverToSemver((lockfile.lockfileVersion ?? 0).toString())
    /* eslint-enable @typescript-eslint/dot-notation */
    if (typeof opts.wantedVersion !== 'number' || semver.major(lockfileSemver) === semver.major(comverToSemver(opts.wantedVersion.toString()))) {
      if (typeof opts.wantedVersion === 'number' && semver.gt(lockfileSemver, comverToSemver(opts.wantedVersion.toString()))) {
        logger.warn({
          message: `Your ${WANTED_LOCKFILE} was generated by a newer version of pnpm. ` +
            `It is a compatible version but it might get downgraded to version ${opts.wantedVersion}`,
          prefix,
        })
      }
      return { lockfile: lockfile as Lockfile, hadConflicts }
    }
  }
  if (opts.ignoreIncompatible) {
    logger.warn({
      message: `Ignoring not compatible lockfile at ${lockfilePath}`,
      prefix,
    })
    return { lockfile: null, hadConflicts: false }
  }
  throw new LockfileBreakingChangeError(lockfilePath)
}

export function createLockfileObject (
  importerIds: string[],
  opts: {
    lockfileVersion: number
  }
) {
  const importers = importerIds.reduce((acc, importerId) => {
    acc[importerId] = {
      dependencies: {},
      specifiers: {},
    }
    return acc
  }, {})
  return {
    importers,
    lockfileVersion: opts.lockfileVersion || LOCKFILE_VERSION,
  }
}

async function _mergeGitBranchLockfiles (
  lockfile: Lockfile | null,
  lockfileDir: string,
  prefix: string,
  opts: {
    autofixMergeConflicts?: boolean
    wantedVersion?: number
    ignoreIncompatible: boolean
  }
): Promise<Lockfile | null> {
  if (!lockfile) {
    return lockfile
  }
  const gitBranchLockfiles: Array<(Lockfile | null)> = (await _readGitBranchLockfiles(lockfileDir, prefix, opts)).map(({ lockfile }) => lockfile)

  for (const gitBranchLockfile of gitBranchLockfiles) {
    if (gitBranchLockfile?.packages) {
      lockfile.packages = {
        ...lockfile.packages,
        ...gitBranchLockfile.packages,
      }
    }
  }

  return lockfile
}

async function _readGitBranchLockfiles (
  lockfileDir: string,
  prefix: string,
  opts: {
    autofixMergeConflicts?: boolean
    wantedVersion?: number
    ignoreIncompatible: boolean
  }
): Promise<Array<{
    lockfile: Lockfile | null
    hadConflicts: boolean
  }>> {
  const files = await getGitBranchLockfileNames(lockfileDir)

  return Promise.all(files.map((file) => _read(path.join(lockfileDir, file), prefix, opts)))
}