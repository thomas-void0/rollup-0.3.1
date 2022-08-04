const path = require("path")
const fs = require("fs")
const MS = require("magic-string")
const acorn = require("acorn")

class Bundle {
  constructor(options) {
    this.entryPath = path.resolve(options.entry)
    this.options = options
  }

  // 打包开始
  build() {
    // 找到模块
    const entryModule = this.fetchMoudle()
    this.statements = entryModule.expandAllStatement()
    const { code } = this.generate()
    const { dir, filename } = this.options.output
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      fs.writeFileSync(`${dir}/${filename}`, code, "utf-8")
    }
  }

  // 获取模块对象
  fetchMoudle() {
    const route = this.entryPath
    if (!route) return

    // 读取出源代码
    const code = fs.readFileSync(route, "utf-8")
    // 创建module实例
    return new Module({
      code,
      path: route,
      bundle: this
    })
  }

  // 生成代码写入文件
  generate() {
    const magicString = new MS.Bundle()
    this.statements.forEach(statement => {
      const source = statement._source;
      magicString.addSource({
        content: source,
        separator: '\n'
      })
    })

    return { code: magicString.toString() }
  }
}

class Module {
  constructor(moduleInfo) {
    const { code, path, bundle } = moduleInfo
    this.code = new MS(code, { filename: path })
    this.path = path
    this.bundle = bundle
    this.ast = acorn.parse(code, {
      ecmaVersion: 7,
      sourceType: "module"
    })
    this.analyse()
  }

  // 展开所有代码语句
  expandAllStatement() {
    const allStatements = []
    this.ast.body.forEach(statement => {
      const statements = this.expandStatement(statement)
      allStatements.push(...statements)
    })
    return allStatements
  }

  // 展开单个代码语句
  expandStatement(statement) {
    const result = []
    if (!statement._included) {
      statement._included = true
      result.push(statement)
    }
    return result
  }

  // 分析代码
  analyse() {
    const ast = this.ast
    const magicString = this.code

    ast.body.forEach(statement => {
      Object.defineProperties(statement, {
        _source: { value: magicString.snip(statement.start, statement.end) }
      })
    })
  }
}

function rollup(options) {
  const bundle = new Bundle(options)
  bundle.build()
}

module.exports = rollup