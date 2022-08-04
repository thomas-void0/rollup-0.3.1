const rollup = require("./index")

rollup("./test.js", {
  output: './dist/bundle.js'
})