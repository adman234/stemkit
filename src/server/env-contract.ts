import type * as DesktopEnv from '../main/env'
import * as WebEnv from './env'

/* Type-only guard: the desktop modules reused by the server (library,
   settings, thumbs, pipeline) import these names from './env', and the build
   swaps that import for src/server/env.ts. If either side changes a
   signature, `npm run web:typecheck` fails here instead of at runtime */

type UsedByDesktopModules =
  | 'userDataDir'
  | 'venvPython'
  | 'venvYtDlp'
  | 'separateScript'
  | 'roformerScript'
  | 'modelsDir'
  | 'ensureEngineDeps'
  | 'ensureVocalsEngine'
  | 'ensureFtWeights'
  | 'ensureGpuEngine'
  | 'getStatus'
  | 'ytDlpRuntimeArgs'

export const envContract: Pick<typeof DesktopEnv, UsedByDesktopModules> = WebEnv
