/**
 * Twikoo EdgeOne Pages 构建脚本
 * 
 * 处理不兼容包的覆写，类似 Cloudflare 版本的处理方式
 */

const fs = require('fs')
const path = require('path')

const srcDir = __dirname

console.log('Twikoo EdgeOne Pages 构建脚本')
console.log('==============================')
console.log('')

// 需要覆写的不兼容包（EdgeOne Node Function 不支持这些包）
const packagesToOverwrite = [
  // jsdom 依赖 canvas，Node Function 不支持
  'node_modules/jsdom/lib/api.js',
  // tencentcloud-sdk 体积大且不兼容
  'node_modules/tencentcloud-sdk-nodejs/tencentcloud/index.js',
  // nodemailer 在某些环境下有兼容性问题
  'node_modules/nodemailer/lib/nodemailer.js',
]

console.log('步骤 1: 覆写不兼容的包...')
let overwriteCount = 0
for (const pkg of packagesToOverwrite) {
  const filePath = path.join(srcDir, pkg)
  if (fs.existsSync(filePath)) {
    // 备份原文件（如果还没备份）
    const backupPath = filePath + '.backup'
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath)
    }
    // 覆写为空模块
    fs.writeFileSync(filePath, '// Overwritten for EdgeOne Pages compatibility\nmodule.exports = {};\n')
    console.log(`  ✓ 已覆写: ${pkg}`)
    overwriteCount++
  } else {
    console.log(`  - 跳过（不存在）: ${pkg}`)
  }
}
console.log(`  共覆写 ${overwriteCount} 个文件`)
console.log('')

// 检查必要文件
console.log('步骤 2: 检查项目文件...')
const requiredFiles = [
  'node-functions/index.js',
  'edge-functions/api/kv.js',
  'package.json'
]

let allFilesExist = true
for (const file of requiredFiles) {
  const filePath = path.join(srcDir, file)
  if (fs.existsSync(filePath)) {
    console.log(`  ✓ ${file}`)
  } else {
    console.log(`  ✗ ${file} (缺失)`)
    allFilesExist = false
  }
}

console.log('')
if (allFilesExist) {
  console.log('构建完成！所有文件已就绪。')
  console.log('')
  console.log('项目结构：')
  console.log('  node-functions/index.js       - Node Function 主入口')
  console.log('  edge-functions/api/kv.js      - Edge Function KV API')
  console.log('')
  console.log('部署说明：')
  console.log('  1. 在 EdgeOne Pages 控制台创建项目')
  console.log('  2. 创建 KV 命名空间并绑定，变量名：TWIKOO_KV')
  console.log('  3. 推送代码触发部署')
} else {
  console.log('错误：部分必要文件缺失，请检查项目结构')
  process.exit(1)
}
