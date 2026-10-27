// Extension function: (value, arguments) => result, like the reference `functions[name](value, args)`.
export type ExtensionFunction = (value: never, args: unknown[]) => unknown;

export interface ExtensionMap {
  typeName: string;
  functions: Record<string, ExtensionFunction>;
}
