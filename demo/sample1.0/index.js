// sample版本rollup
const MagicString = require("magic-string")
const path = require("path")
const fs = require("fs")
const acorn = require("acorn")

class Bundle {
  constructor(options) {
    // 入口文件地址
    this.entryPath = path.resolve(options.entry).replace(/\.js$/, '') + '.js'
    this.options = options
  }

  build() {
    const entryModule = this.fetchModule(this.entryPath)
    this.statements = entryModule.expandAllStatement()
    const { code } = this.generate()
    fs.writeFileSync(this.options.output, code, "utf-8")
  }

  fetchModule(importee) {
    const route = importee
    if (!route) return
    // 读取出模块的源代码
    const code = fs.readFileSync(route, "utf-8");

    const module = new Module({
      code,
      path: route,
      bundle: this
    })
    return module
  }

  // 将this.statements生成代码
  generate() {
    const magicString = new MagicString.Bundle()
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

// 每一个文件都是一个模块，每个模块都对应一个module
class Module {
  constructor(moduleInfo) {
    const { code, path, bundle } = moduleInfo
    this.code = new MagicString(code, { filename: path });
    this.path = path;
    this.bundle = bundle;
    this.ast = acorn.parse(code, {
      ecmaVersion: 7,
      sourceType: "module"
    })
    this.analyse();
  }

  analyse() {
    analyse(this.ast, this.code)
  }

  // 展开所有的节点
  expandAllStatement() {
    const allStatements = []
    this.ast.body.forEach(statement => {
      const statements = this.expandStatement(statement)
      allStatements.push(...statements)
    })
    return allStatements
  }

  // 展开一个节点
  expandStatement(statement) {
    const result = []
    if (!statement._included) {
      //表示这个节点已经确定被纳入结果 里了，以后就不需要重复添加了
      statement._included = true
      result.push(statement)
    }
    return result
  }
}

function analyse(ast, magicString) {
  ast.body.forEach(statement => {
    /*
    start指的是此节点在源代码中的起始索引,end就是结束索引
    magicString.snip返回的还是magicString 实例clone
    */
    Object.defineProperties(statement, {
      _source: { value: magicString.snip(statement.start, statement.end) }
    })
  })
}

function rollup(entry, options) {
  const bundle = new Bundle({ entry, ...options })
  bundle.build()
}

module.exports = rollup