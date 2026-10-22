// Registry of the supported node types.
import type { NodeType } from './types.js';

export class NodeRegistry {
  private readonly types = new Map<string, NodeType>();

  register(nodeType: NodeType): void {
    this.types.set(nodeType.type, nodeType);
  }

  get(type: string): NodeType | undefined {
    return this.types.get(type);
  }

  /** Returns the type only if the version is supported */
  getVersioned(type: string, version: number): NodeType | undefined {
    const t = this.types.get(type);
    if (!t) return undefined;
    return t.versions.includes(version) ? t : undefined;
  }

  /** Remove a type (community package uninstalled) */
  unregister(type: string): boolean {
    return this.types.delete(type);
  }

  has(type: string): boolean {
    return this.types.has(type);
  }

  list(): NodeType[] {
    return [...this.types.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  clone(): NodeRegistry {
    const r = new NodeRegistry();
    for (const t of this.types.values()) r.register(t);
    return r;
  }
}
