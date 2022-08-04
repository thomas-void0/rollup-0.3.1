const rollup = require("./index")

rollup({
  entry: "./test.js",
  output: {
    dir: "./dist",
    filename: "bundle.js"
  }
})