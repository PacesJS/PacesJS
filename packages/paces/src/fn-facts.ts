import { ORIGIN_NAMES, functionName } from '@pacesjs/engine';
import type { ExecutionModel, FnId, OriginId } from '@pacesjs/engine';

export const originName = (o: number): string => ORIGIN_NAMES[o] ?? 'user';

export interface FnFacts {
  name: string;
  file: string;
  line: number;
  pkg: string;
  origin: OriginId;
}

/**
 * The columns that identify one function, as the report and the MCP tools both print them. The report writes
 * paths with `/` (`slashes`); the MCP tools hand the file over exactly as recorded.
 */
export function fnFacts(model: ExecutionModel, fn: FnId, slashes: boolean): FnFacts {
  const file = model.strings[model.functions.file[fn] ?? 0] ?? '';
  return {
    name: functionName(model, fn),
    file: slashes ? file.replaceAll('\\', '/') : file,
    line: model.functions.line[fn] ?? 0,
    pkg: model.strings[model.functions.pkg[fn] ?? 0] ?? '',
    origin: (model.functions.origin[fn] ?? 0) as OriginId,
  };
}
