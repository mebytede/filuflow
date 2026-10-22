// Extension function: (value, arguments) => result, like n8n `functions[name](value, args)`.
export type ExtensionFunction = (value: never, args: unknown[]) => unknown;

export interface ExtensionMap {
  typeName: string;
  functions: Record<string, ExtensionFunction>;
}
