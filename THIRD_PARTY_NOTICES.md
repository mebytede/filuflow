# Third-party notices

filuflow is licensed under the GNU Affero General Public License v3.0 or later (see [LICENSE](LICENSE)). It contains or
ships the following third-party material, which remains under its own license. Nothing in filuflow's license changes the
terms of these components.

| Component | Where | License |
|---|---|---|
| IBM Plex Sans and IBM Plex Mono (woff2 subsets) | `src/ui/static/fonts/` | SIL Open Font License 1.1 |
| Lucide icons 0.545.0 (path data) | `src/ui/icons.ts` | ISC; icons derived from Feather: MIT |
| Separator lists from `@langchain/textsplitters` 1.0.1 (data only) | `src/ai/documents.ts` | MIT |
| Pyodide 0.28.0 (unmodified npm package) | `node_modules/pyodide`, Docker image | MPL-2.0 |
| Other npm packages (runtime dependencies) | `node_modules/`, Docker image | their own licenses, see the table below |

## IBM Plex

The fonts in `src/ui/static/fonts/` are unmodified woff2 subsets (Latin and Latin Extended) of IBM Plex Sans and IBM
Plex Mono. Source: <https://github.com/IBM/plex>. License text as published in that repository (`LICENSE.txt`):

```text
Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"

This Font Software is licensed under the SIL Open Font License, Version 1.1.

This license is copied below, and is also available with a FAQ at: http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Lucide icons

`src/ui/icons.ts` contains SVG path data generated from the `lucide-static` package, version 0.545.0
(<https://lucide.dev>, <https://github.com/lucide-icons/lucide>). Some icons are derived from Feather
(<https://github.com/feathericons/feather>). License text as shipped in `lucide-static@0.545.0`:

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2023 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2025.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The MIT License (MIT) (for portions derived from Feather)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @langchain/textsplitters

`src/ai/documents.ts` is an own implementation; only the lists of separators per programming language are taken
verbatim as data from `@langchain/textsplitters` 1.0.1 (<https://github.com/langchain-ai/langchainjs>). License text
as shipped in that package:

```text
MIT License

Copyright (c) LangChain, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Pyodide

Pyodide 0.28.0 (<https://pyodide.org>, <https://github.com/pyodide/pyodide>) runs Python in the Code node. It is
installed from npm as a regular dependency and shipped unmodified in `node_modules/pyodide` (and therefore in the
Docker image). Pyodide is licensed under the Mozilla Public License 2.0:
<https://www.mozilla.org/en-US/MPL/2.0/>. The source code is available at the repository above. The Pyodide
distribution contains further components, notably CPython and its standard library (`python_stdlib.zip`) under the
Python Software Foundation License; see the Pyodide repository for the full list. Python packages that Pyodide loads
at runtime on request are downloaded separately and keep their own licenses.

## npm dependencies

All npm packages keep their own licenses; their license files are in the respective folder under `node_modules/`
(also in the Docker image under `/app/node_modules`). The following summary covers the runtime dependencies (direct
and transitive) as resolved in `package-lock.json`. Regenerate it after dependency changes with
`node scripts/third-party-licenses.mjs --write` (`--check` reports whether it is up to date).

<!-- third-party-licenses:start -->
<!-- Generated by scripts/third-party-licenses.mjs --write. Do not edit by hand. -->

137 runtime packages (direct and transitive, without dev dependencies).

| License | Packages |
|---|---|
| MIT | 105 |
| BSD-2-Clause | 12 |
| ISC | 11 |
| BSD-3-Clause | 5 |
| 0BSD | 1 |
| Apache-2.0 | 1 |
| BlueOak-1.0.0 | 1 |
| MPL-2.0 | 1 |

<details>
<summary>All runtime packages</summary>

| Package | Version | License | Source |
|---|---|---|---|
| @fastify/ajv-compiler | 4.0.7 | MIT | https://github.com/fastify/ajv-compiler |
| @fastify/deepmerge | 3.2.2 | MIT | https://github.com/fastify/deepmerge |
| @fastify/error | 4.2.1 | MIT | https://github.com/fastify/fastify-error |
| @fastify/fast-json-stringify-compiler | 5.1.1 | MIT | https://github.com/fastify/fast-json-stringify-compiler |
| @fastify/forwarded | 3.1.1 | MIT | https://github.com/fastify/forwarded |
| @fastify/merge-json-schemas | 0.2.2 | MIT | https://github.com/fastify/merge-json-schemas |
| @fastify/proxy-addr | 5.1.2 | MIT | https://github.com/fastify/proxy-addr |
| @pinojs/redact | 0.4.0 | MIT | https://github.com/pinojs/redact |
| @selderee/plugin-htmlparser2 | 0.11.0 | MIT | https://github.com/mxxii/selderee |
| abstract-logging | 2.0.1 | MIT | https://github.com/jsumners/abstract-logging |
| acorn | 8.19.0 | MIT | https://github.com/acornjs/acorn |
| ajv | 8.20.0 | MIT | https://github.com/ajv-validator/ajv |
| ajv-formats | 3.0.1 | MIT | https://github.com/ajv-validator/ajv-formats |
| alasql | 4.4.0 | MIT | http://github.com/alasql/alasql |
| ansi-regex | 5.0.1 | MIT | https://github.com/chalk/ansi-regex |
| ansi-styles | 4.3.0 | MIT | https://github.com/chalk/ansi-styles |
| astring | 1.9.0 | MIT | https://github.com/davidbonnet/astring |
| atomic-sleep | 1.0.0 | MIT | https://github.com/davidmarkclements/atomic-sleep |
| avvio | 9.3.1 | MIT | https://github.com/fastify/avvio |
| better-sqlite3 | 13.0.3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| boolbase | 1.0.0 | ISC | https://github.com/fb55/boolbase |
| call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| cheerio | 1.0.0-rc.6 | MIT | https://github.com/cheeriojs/cheerio |
| cheerio-select | 1.6.0 | BSD-2-Clause | https://github.com/cheeriojs/cheerio-select |
| cliui | 7.0.4 | ISC | https://github.com/yargs/cliui |
| cliui | 8.0.1 | ISC | https://github.com/yargs/cliui |
| color-convert | 2.0.1 | MIT | https://github.com/Qix-/color-convert |
| color-name | 1.1.4 | MIT | git@github.com:colorjs/color-name |
| cookie | 2.0.1 | MIT | https://github.com/jshttp/cookie |
| croner | 10.0.1 | MIT | https://github.com/hexagon/croner |
| cross-fetch | 4.1.0 | MIT | https://github.com/lquixada/cross-fetch |
| css-select | 4.3.0 | BSD-2-Clause | https://github.com/fb55/css-select |
| css-what | 6.2.2 | BSD-2-Clause | https://github.com/fb55/css-what |
| deepmerge | 4.3.1 | MIT | https://github.com/TehShrike/deepmerge |
| dequal | 2.0.3 | MIT | https://github.com/lukeed/dequal |
| dom-serializer | 1.4.1 | MIT | https://github.com/cheeriojs/dom-renderer |
| dom-serializer | 2.0.0 | MIT | https://github.com/cheeriojs/dom-serializer |
| domelementtype | 2.3.0 | BSD-2-Clause | https://github.com/fb55/domelementtype |
| domhandler | 4.3.1 | BSD-2-Clause | https://github.com/fb55/domhandler |
| domhandler | 5.0.3 | BSD-2-Clause | https://github.com/fb55/domhandler |
| domutils | 2.8.0 | BSD-2-Clause | https://github.com/fb55/domutils |
| domutils | 3.2.2 | BSD-2-Clause | https://github.com/fb55/domutils |
| dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| emoji-regex | 8.0.0 | MIT | https://github.com/mathiasbynens/emoji-regex |
| entities | 2.2.0 | BSD-2-Clause | https://github.com/fb55/entities |
| entities | 4.5.0 | BSD-2-Clause | https://github.com/fb55/entities |
| es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| escalade | 3.2.0 | MIT | https://github.com/lukeed/escalade |
| fast-decode-uri-component | 1.0.1 | MIT | https://github.com/delvedor/fast-decode-uri-component |
| fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| fast-json-stringify | 7.1.0 | MIT | https://github.com/fastify/fast-json-stringify |
| fast-querystring | 1.1.2 | MIT | https://github.com/anonrig/fast-querystring |
| fast-uri | 3.1.9 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| fast-uri | 4.2.3 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| fastify | 5.12.7 | MIT | https://github.com/fastify/fastify |
| fastq | 1.20.3 | ISC | https://github.com/mcollina/fastq |
| find-my-way | 9.10.0 | MIT | https://github.com/delvedor/find-my-way |
| function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| get-caller-file | 2.0.5 | ISC | https://github.com/stefanpenner/get-caller-file |
| get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols |
| hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| html-to-text | 9.0.5 | MIT | https://github.com/html-to-text/node-html-to-text |
| htmlparser2 | 6.1.0 | MIT | https://github.com/fb55/htmlparser2 |
| htmlparser2 | 8.0.2 | MIT | https://github.com/fb55/htmlparser2 |
| ipaddr.js | 2.5.0 | MIT | https://github.com/whitequark/ipaddr.js |
| is-fullwidth-code-point | 3.0.0 | MIT | https://github.com/sindresorhus/is-fullwidth-code-point |
| jmespath | 0.16.0 | Apache-2.0 | https://github.com/jmespath/jmespath.js |
| json-schema-ref-resolver | 3.0.1 | MIT | https://github.com/fastify/json-schema-ref-resolver |
| json-schema-traverse | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| jsonrepair | 3.13.1 | ISC | https://github.com/josdejong/jsonrepair |
| leac | 0.6.0 | MIT | https://github.com/mxxii/leac |
| light-my-request | 6.8.0 | BSD-3-Clause | https://github.com/fastify/light-my-request |
| lodash | 4.18.1 | MIT | https://github.com/lodash/lodash |
| luxon | 3.4.4 | MIT | https://github.com/moment/luxon |
| math-expression-evaluator | 2.0.7 | MIT | https://github.com/redhivesoftware/math-expression-evaluator |
| math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| node-addon-api | 8.9.2 | MIT | https://github.com/nodejs/node-addon-api |
| node-fetch | 2.7.0 | MIT | https://github.com/bitinn/node-fetch |
| nth-check | 2.1.1 | BSD-2-Clause | https://github.com/fb55/nth-check |
| object-inspect | 1.13.4 | MIT | https://github.com/inspect-js/object-inspect |
| on-exit-leak-free | 2.1.2 | MIT | https://github.com/mcollina/on-exit-or-gc |
| parse5 | 6.0.1 | MIT | https://github.com/inikulin/parse5 |
| parse5-htmlparser2-tree-adapter | 6.0.1 | MIT | https://github.com/inikulin/parse5 |
| parseley | 0.12.1 | MIT | https://github.com/mxxii/parseley |
| peberminta | 0.9.0 | MIT | https://github.com/mxxii/peberminta |
| pino | 10.4.0 | MIT | https://github.com/pinojs/pino |
| pino-abstract-transport | 3.0.0 | MIT | https://github.com/pinojs/pino-abstract-transport |
| pino-std-serializers | 7.1.0 | MIT | https://github.com/pinojs/pino-std-serializers |
| process-warning | 5.1.1 | MIT | https://github.com/fastify/process-warning |
| pyodide | 0.28.0 | MPL-2.0 | https://github.com/pyodide/pyodide |
| qs | 6.17.1 | BSD-3-Clause | https://github.com/ljharb/qs |
| quick-format-unescaped | 4.0.4 | MIT | https://github.com/davidmarkclements/quick-format |
| real-require | 1.0.0 | MIT | https://github.com/pinojs/real-require |
| require-directory | 2.1.1 | MIT | https://github.com/troygoode/node-require-directory |
| require-from-string | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |
| ret | 0.5.0 | MIT | https://github.com/fent/ret.js |
| reusify | 1.1.0 | MIT | https://github.com/mcollina/reusify |
| rfdc | 1.4.1 | MIT | https://github.com/davidmarkclements/rfdc |
| safe-regex2 | 5.1.2 | MIT | https://github.com/fastify/safe-regex2 |
| safe-stable-stringify | 2.5.0 | MIT | https://github.com/BridgeAR/safe-stable-stringify |
| sax | 1.6.1 | BlueOak-1.0.0 | https://github.com/isaacs/sax-js |
| secure-json-parse | 4.1.1 | BSD-3-Clause | https://github.com/fastify/secure-json-parse |
| selderee | 0.11.0 | MIT | https://github.com/mxxii/selderee |
| semver | 7.8.5 | ISC | https://github.com/npm/node-semver |
| set-cookie-parser | 3.1.3 | MIT | https://github.com/nfriedly/set-cookie-parser |
| side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel |
| side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list |
| side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map |
| side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap |
| sonic-boom | 4.2.1 | MIT | https://github.com/pinojs/sonic-boom |
| split2 | 4.2.0 | ISC | https://github.com/mcollina/split2 |
| string-width | 4.2.3 | MIT | https://github.com/sindresorhus/string-width |
| strip-ansi | 6.0.1 | MIT | https://github.com/chalk/strip-ansi |
| thread-stream | 4.2.0 | MIT | https://github.com/mcollina/thread-stream |
| title-case | 3.0.3 | MIT | https://github.com/blakeembrey/change-case |
| toad-cache | 3.7.4 | MIT | https://github.com/kibertoad/toad-cache |
| tr46 | 0.0.3 | MIT | https://github.com/Sebmaster/tr46.js |
| transliteration | 2.3.5 | MIT | https://github.com/dzcpy/transliteration |
| tslib | 2.8.1 | 0BSD | https://github.com/Microsoft/tslib |
| undici | 8.12.3 | MIT | https://github.com/nodejs/undici |
| webidl-conversions | 3.0.1 | BSD-2-Clause | https://github.com/jsdom/webidl-conversions |
| whatwg-url | 5.0.0 | MIT | https://github.com/jsdom/whatwg-url |
| wrap-ansi | 7.0.0 | MIT | https://github.com/chalk/wrap-ansi |
| ws | 8.22.0 | MIT | https://github.com/websockets/ws |
| xml2js | 0.6.2 | MIT | https://github.com/Leonidas-from-XIV/node-xml2js |
| xmlbuilder | 11.0.1 | MIT | https://github.com/oozcitak/xmlbuilder-js |
| y18n | 5.0.8 | ISC | https://github.com/yargs/y18n |
| yargs | 16.2.2 | MIT | https://github.com/yargs/yargs |
| yargs | 17.7.3 | MIT | https://github.com/yargs/yargs |
| yargs-parser | 20.2.9 | ISC | https://github.com/yargs/yargs-parser |
| yargs-parser | 21.1.1 | ISC | https://github.com/yargs/yargs-parser |

</details>
<!-- third-party-licenses:end -->
