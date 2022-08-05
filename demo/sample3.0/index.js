const fs = require("fs");

import MagicString from 'magic-string';
import getLocation from '../../src/utils/getLocation';
import { parse } from 'acorn';

const path = require("path");
const { default: makeLegalIdentifier } = require("../../src/utils/makeLegalIdentifier");

let SOURCEMAPPING_URL = 'sourceMa';
SOURCEMAPPING_URL += 'ppingURL';

function rollup(entry, options = {}) {

  const bundle = new Bundle({
    entry,
    resolvePath: options.resolvePath
  })

  return bundle.build().then(() => ({
    generate: options => bundle.generate(options),
    write: (dest, options = {}) => {
      let { code, map } = bundle.generate({
        dest,
        format: options.format,
        globalName: options.globalName
      })

      code += `\n//# ${SOURCEMAPPING_URL}=${path.basename(dest)}.map`;

      return Promise.all([
        fs.writeFile(dest, code),
        fs.writeFile(dest + '.map', map.toString())
      ])
    }
  }))
}

function defaultResolver(importee, importer) {
  if (path.isAbsolute(importee)) return importee

  if (importee[0] !== '.') return false

  return path.resolve(path.dirname(importer), importee).replace(/\.js$/, '') + '.js';
}

class Bundle {
  constructor(options) {
    this.entryPath = path.resolve(options.entry).replace(/\.js$/, '') + '.js';
    this.base = path.dirname(this.entryPath)

    this.resolvePath = options.resolvePath || defaultResolver

    this.entryModule = null
    this.modulePromises = {}
    this.statements = {}
    this.externalModules = []
    this.defaultExportName = null
    this.internalNamespaceModules = []
  }

  // 开始打包
  build() {
    return this.fetchModule(this.entryPath, null).then(entryModule => {
      this.entryModule = entryModule

      if (entryModule.exports.default) {
        let defaultExportName = makeLegalIdentifier(path.basename(this.entryPath).slice(0, -path.extname(this.entryPath).length));
        while (entryModule.ast._scope.contains(defaultExportName)) {
          defaultExportName = `_${defaultExportName}`
        }

        entryModule.suggestName('default', defaultExportName)
      }

      return entryModule.expandAllStatement(true)
    }).then(statements => {
      this.statements = statements;
      this.deconflict()
    })
  }

  // 获取模块对象
  fetchModule(importee, importer) {
    return Promise.resolve(importer === null ? importer : this.resolvePath(importee, importer))
      .then(path => {
        if (!path) {
          if (!this.modulePromises[importee]) {
            const module = new ExternalModule(importee)
            this.externalModules.push(module)
            this.modulePromises[importee] = Promise.resolve(module)
          }

          return this.modulePromises[importee]
        }

        if (!this.modulePromises[path]) {
          this.modulePromises[path] = fs.readFile(path, { encoding: "utf-8" })
            .then(code => {
              const module = new Module({
                path,
                code,
                bundle: this
              })

              return module
            })
        }

        return this.modulePromises[path]
      })
  }

  // 生成代码
  generate() {

  }

  // 处理冲突
  deconflict() {
    let definers = {}
    let conflicts = {}

    // 找到语句中的冲突
    this.statements.forEach(statement => {
      Object.keys(statement._defines).forEach(name => {
        if (definers[name]) {
          conflicts[name] = true
        } else {
          definers[name] = []
        }

        definers[name].push(statement._module);
      })
    })

    this.externalModules.forEach(module => {
      const name = makeLegalIdentifier(module.suggestNames['*'] || module.suggestNames.default || module.id)
      if (definers[name]) {
        conflicts[name] = true
      } else {
        definers[name] = []
      }

      definers[name].push(module)
      module.name = name
    })

    // 重新命名冲突的标识符，使它们可以位于相同的范围内
    Object.keys(conflicts).forEach(name => {
      const modules = definers[name]
      modules.pop()

      modules.forEach(module => {
        const replacement = getSafeName(name);
        module.rename(name, replacement)
      })
    })

    function getSafeName(name) {
      while (conflicts[name]) {
        name = `_${name}`
      }
      conflicts[name] = true
      return name
    }
  }
}

class ExternalModule {

}

class Module {
  constructor({ path, code, bundle }) {
    this.bundle = bundle;
    this.path = path;
    this.relativePath = 'remove.js'

    this.code = new MagicString(code, {
      filename: path
    })

    this.suggestNames = {}
    this.comments = []

    try {
      this.ast = parse(code, {
        ecmaVersion: 6,
        sourceType: "module",
        onComment: (block, text, start, end) => this.comments.push({ block, text, start, end })
      })
    } catch (error) {
      error.file = path
      throw error;
    }

    this.analyse()
  }

  // 基于ast分析模块
  analyse() {
    this.imports = {}
    this.exports = {}

    this.ast.body.forEach(node => {
      let source;

      if (node.type === "ImportDeclaration") {
        source = node.source.value;

        node.specifiers.forEach(specifier => {
          const isDefault = specifier.type === "ImportDeclaration"
          const isNamespace = specifier.type === "ImportNamespaceSpecifier"

          const localName = specifier.local.name
          const name = isDefault ? 'default' : isNamespace ? '*' : specifier.imported.name

          if (this.imports[localName]) {
            const err = new Error(`Duplicated import '${localName}'`);
            err.file = this.path
            err.loc = getLocation(this.code.original, specifier.start)
            throw err;
          }

          this.imports[localName] = {
            source,
            name,
            localName
          }
        })

      } else if (/^Export/.test(node.type)) {
        if (node.type === "ExportDefaultDeclaration") {
          const isDeclaration = /Declaration$/.test(node.declaration.type);

          this.exports.default = {
            node,
            name: 'default',
            localName: isDeclaration ? node.declaration.id.name : "default",
            isDeclaration
          }
        } else if (node.type === "ExportNamedDeclaration") {
          source = node.source && node.source.value

          if (node.specifiers.length) {
            node.specifiers.forEach(specifier => {
              const localName = specifier.local.name
              const exportedName = specifier.exported.name;

              this.exports[exportedName] = {
                localName,
                exportedName
              }

              if (source) {
                this.imports[localName] = {
                  source,
                  localName,
                  name: exportedName
                }
              }
            })
          } else {
            let declaration = node.declaration
            let name;

            if (declaration.type === "VariableDeclaration") {
              name = declaration.declarations[0].id.name
            } else {
              name = declaration.id.name
            }

            this.exports[name] = {
              node,
              localName: name,
              expression: declaration
            }
          }
        }
      }
    });

    analyse(this.ast, this.code, this);

    this.definedNames = this.ast._scope.names.slice()

    this.canonicalNames = {};

    this.definitions = {}
    this.definitionPromises = {}
    this.modifications = {}

    this.ast.body.forEach(statement => {
      Object.keys(statement._defines).forEach(name => {
        this.definitions[name] = statement
      })

      Object.keys(statement._modifies).forEach(name => {
        if (this.modifications[name]) {
          this.modifications[name] = []
        }

        this.modifications[name].push(statement)
      })

    })
  }

  // 重命名
  rename(name, replacement) {
    this.canonicalNames[name] = replacement
  }

  // 建议名称
  suggestName(exportName, suggestion) {
    if (!this.suggestNames[exportName]) {
      this.suggestNames[exportName] = makeLegalIdentifier(suggestion)
    }
  }

  // 展开所有的语句
  expandAllStatements() {

  }

  // 展开语句
  expandStatements() {

  }
}


module.exports = rollup