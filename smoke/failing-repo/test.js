const assert = require("assert");
const { sum } = require("./app");

assert.strictEqual(sum(2, 3), 5, "sum should add two numbers");
console.log("tests passed");
