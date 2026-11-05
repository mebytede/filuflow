'use strict';
// Versioned programmatic node with dynamic option lists (M47c): methods.loadOptions (dependsOn, "&" relative paths,
// extractValue) and methods.listSearch with pagination. Version 2 declares other methods than version 1.

async function request(ctx, path, qs) {
  const credentials = await ctx.getCredentials('katalogApi');
  return ctx.helpers.httpRequestWithAuthentication.call(ctx, 'katalogApi', { method: 'GET', url: `${credentials.url}${path}`, qs, json: true });
}

const itemModes = [
  { displayName: 'From List', name: 'list', type: 'list', typeOptions: { searchListMethod: 'searchItems', searchable: true } },
  {
    displayName: 'By URL', name: 'url', type: 'string', placeholder: 'https://catalog.example.com/items/42',
    extractValue: { type: 'regex', regex: 'https://catalog\\.example\\.com/items/([0-9]+)' },
    validation: [{ type: 'regex', properties: { regex: 'https://catalog\\.example\\.com/items/[0-9]+', errorMessage: 'Not a catalog URL' } }],
  },
  { displayName: 'ID', name: 'id', type: 'string', validation: [{ type: 'regex', properties: { regex: '^[0-9]+$', errorMessage: 'Digits only' } }, function check() {}] },
];

const shared = [
  { displayName: 'Project', name: 'project', type: 'options', typeOptions: { loadOptionsMethod: 'getProjects' }, default: '', description: 'Project of the entry' },
  { displayName: 'Board', name: 'board', type: 'options', typeOptions: { loadOptionsMethod: 'getBoards', loadOptionsDependsOn: ['project'] }, default: '' },
  {
    displayName: 'Filters', name: 'filters', type: 'collection', default: {},
    options: [
      { displayName: 'Scope', name: 'scope', type: 'string', default: 'all' },
      { displayName: 'Tags', name: 'tags', type: 'multiOptions', typeOptions: { loadOptionsMethod: 'getTags', loadOptionsDependsOn: ['&scope'] }, default: [] },
    ],
  },
  { displayName: 'Item', name: 'item', type: 'resourceLocator', default: { mode: 'list', value: '' }, modes: itemModes },
  { displayName: 'Item Details', name: 'details', type: 'options', typeOptions: { loadOptionsMethod: 'getItemDetails', loadOptionsDependsOn: ['item'] }, default: '' },
];

const v1Methods = {
  loadOptions: {
    async getProjects() {
      const res = await request(this, '/projects');
      return res.projects.map((p) => ({ name: p.title, value: p.id }));
    },
    async getBoards() {
      const project = this.getCurrentNodeParameter('project');
      // getNodeParameter without item index, the same value
      if (this.getNodeParameter('project') !== project) throw new Error('getNodeParameter and getCurrentNodeParameter differ');
      const res = await request(this, `/projects/${project}/boards`);
      return res.boards.map((b) => ({ name: b.title, value: b.id, description: `${this.getNode().name} v${this.getNode().typeVersion}` }));
    },
    async getTags() {
      const scope = this.getCurrentNodeParameter('&scope');
      const res = await request(this, '/tags', { scope });
      return res.tags.map((t) => ({ name: t, value: t }));
    },
    async getItemDetails() {
      const id = this.getCurrentNodeParameter('item', { extractValue: true });
      const all = this.getCurrentNodeParameters();
      return [{ name: `Item ${id}`, value: String(id), description: `mode ${all.item.mode}` }];
    },
    async getLegacy() {
      return [{ name: 'Legacy', value: 'legacy' }];
    },
    // Names of Object.prototype are refused even as own properties
    async constructor() {
      return [{ name: 'never', value: 'never' }];
    },
    notAFunction: 'x',
  },
  listSearch: {
    async searchItems(filter, paginationToken) {
      const res = await request(this, '/items', { q: filter || '', page: paginationToken || 1 });
      return { results: res.items.map((i) => ({ name: i.title, value: i.id, url: i.url })), paginationToken: res.next };
    },
  },
};

const v2Methods = {
  loadOptions: {
    async getProjects() {
      const res = await request(this, '/projects');
      return res.projects.map((p) => ({ name: p.title.toUpperCase(), value: p.id, description: 'version 2' }));
    },
    getBoards: v1Methods.loadOptions.getBoards,
    getTags: v1Methods.loadOptions.getTags,
    getItemDetails: v1Methods.loadOptions.getItemDetails,
  },
  listSearch: { searchItems: v1Methods.listSearch.searchItems },
};

async function execute() {
  const project = this.getNodeParameter('project', 0);
  return [this.getInputData().map((item) => ({ json: { ...item.json, project } }))];
}

class KatalogV1 {
  constructor(base) {
    this.description = { ...base, version: 1, inputs: ['main'], outputs: ['main'], properties: shared };
    this.methods = v1Methods;
    this.execute = execute;
  }
}

class KatalogV2 {
  constructor(base) {
    const properties = shared.map((p) => (p.name === 'item' ? { ...p, modes: [{ ...itemModes[0], typeOptions: { ...itemModes[0].typeOptions, searchFilterRequired: true } }, ...itemModes.slice(1)] } : p));
    this.description = { ...base, version: 2, inputs: ['main'], outputs: ['main'], properties };
    this.methods = v2Methods;
    this.execute = execute;
  }
}

class Katalog {
  constructor() {
    const base = { displayName: 'Catalog', name: 'katalog', group: ['transform'], defaultVersion: 2, credentials: [{ name: 'katalogApi', required: true }] };
    this.description = base;
    this.currentVersion = 2;
    this.nodeVersions = { 1: new KatalogV1(base), 2: new KatalogV2(base) };
  }
}
exports.Katalog = Katalog;
