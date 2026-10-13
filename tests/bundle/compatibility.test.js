// Run the HTTP compatibility contract against the exact deployment artifact.
process.env.TWIKOO_TEST_BUNDLE = '1'
await import('../compatibility.test.js')
