const fs = require("fs");
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

}


module.exports = rollup