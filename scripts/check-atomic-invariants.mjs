/**
 * 并发不变量的静态检查（铁律 14）。
 *
 * 本项目**唯一反复复发的缺陷类**是「配额检查与累加之间隔着一次 `await`」——
 * 32 并发把 4MB 房间打到 **8.39×**、限额 5 被 50 并发打成 50 个 201（**10×**）都是它。
 * 这类缺陷在 code review 里极难看出（多一行 `await` 而已），在测试里也只能靠并发用例
 * 撞上；而它一旦复发就是**静默超配额**。因此把它变成可执行的断言。
 *
 * 检查三件事，都针对 `server/relay-state.js`：
 *
 * 1. 名单里的原子函数**存在**，且 JSDoc 带 `@atomic` 标记
 *    —— 缺标记说明有人删了标记（检查会随之静默失效），改名说明名单该同步了。
 * 2. 原子函数**自身作用域内没有 `await`**（嵌套函数内部的 `await` 不算：
 *    定义一个新函数不会让出控制权）。同时禁止把它们声明成 `async`。
 * 3. 配额计数字段（`storedBytes` / `pendingUploads` / `totalStoredBytes`）的**写入**
 *    只出现在白名单函数里 —— 把「relay-state 是唯一可改配额计数处」再收窄一层：
 *    不是「这个文件里随便哪都能改」，而是「只有这几个函数能改」。
 *
 * 为什么用 TypeScript 编译器 API 而不是正则：`await` 可能出现在字符串/注释里，
 * 而「嵌套函数不算」这条正则根本表达不了（会误报 `reserveStorageQuota` 里返回的闭包）。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import ts from 'typescript'

/** 必须保持「检查与扣减之间不同步让出控制权」的函数 */
const ATOMIC_FUNCTIONS = ['reserveStorageQuota', 'reserveUploadSlot']

/** 原子函数体内必须出现该 JSDoc 标记 */
const ATOMIC_TAG = '@atomic'

/** 允许直接写配额计数的函数。**改这个名单等于改不变量，请在提交信息里说明理由。** */
const QUOTA_WRITER_ALLOWLIST = [
  // 两个原子原语：唯一的「增加」入口
  'reserveStorageQuota',
  'reserveUploadSlot',
  // 整体回收（房间销毁 / 清理循环 / 启动时按元数据重建）
  'destroyRoom',
  'cleanupRooms',
  'restoreRooms'
]

/** 计数型字段名；出现在赋值左侧即视为「写配额」 */
const QUOTA_COUNTER_FIELDS = new Set(['storedBytes', 'pendingUploads', 'totalStoredBytes'])

/**
 * 取节点前面挂着的注释文本（`@atomic` 就写在里面）。
 *
 * 用 `getLeadingCommentRanges` 而不是 `node.jsDoc`：后者只在 `setParentNodes` 为真时才有，
 * 且对「多段注释 / 注释与声明之间有空行」的行为更绕。
 */
function leadingComment(sourceFile, node) {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? []
  return ranges.map((range) => sourceFile.text.slice(range.pos, range.end)).join('\n')
}

const isFunctionLike = (node) => (
  ts.isFunctionDeclaration(node)
  || ts.isFunctionExpression(node)
  || ts.isArrowFunction(node)
  || ts.isMethodDeclaration(node)
  || ts.isGetAccessor(node)
  || ts.isSetAccessor(node)
)

/** 函数自身作用域内的 `await`（跳过嵌套函数体 —— 定义函数不让出控制权） */
function ownScopeAwaits(root) {
  const found = []

  const visit = (node) => {
    if (ts.isAwaitExpression(node)) found.push(node)
    if (node !== root && isFunctionLike(node)) return
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(root, visit)
  return found
}

/** 一路向上找最近的**具名**函数（匿名箭头函数要回到定义它的那个具名函数） */
function enclosingNamedFunction(node) {
  let current = node.parent

  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (isFunctionLike(current)) {
      const parent = current.parent
      // const x = () => {...} —— 具名函数其实是那个变量
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    }
    current = current.parent
  }

  return null
}

/** 赋值左侧是否为配额计数字段 */
function isQuotaCounterTarget(expression) {
  if (ts.isPropertyAccessExpression(expression)) return QUOTA_COUNTER_FIELDS.has(expression.name.text)
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression
    return Boolean(argument && ts.isStringLiteral(argument) && QUOTA_COUNTER_FIELDS.has(argument.text))
  }
  if (ts.isIdentifier(expression)) return QUOTA_COUNTER_FIELDS.has(expression.text)
  return false
}

const isAssignmentOperator = (kind) => (
  kind === ts.SyntaxKind.EqualsToken
  || kind === ts.SyntaxKind.PlusEqualsToken
  || kind === ts.SyntaxKind.MinusEqualsToken
)

/**
 * @param {string} source relay-state.js 的源码
 * @param {string} fileName 用于报错定位
 * @returns {{ problems: string[] }}
 */
export function checkAtomicInvariants(source, fileName = 'relay-state.js') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true)
  const problems = []

  const at = (node) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${fileName}:${line + 1}:${character + 1}`
  }

  const declarations = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement)
  }

  // —— 检查 1 / 2：原子函数的标记与 `await` ——
  for (const name of ATOMIC_FUNCTIONS) {
    const declaration = declarations.get(name)

    if (!declaration) {
      problems.push(`${fileName}: 名单里的原子函数 \`${name}\` 在源码中找不到 —— 改名后必须同步 ATOMIC_FUNCTIONS`)
      continue
    }

    if (!leadingComment(sourceFile, declaration).includes(ATOMIC_TAG)) {
      problems.push(`${at(declaration)} \`${name}\` 的 JSDoc 缺少 ${ATOMIC_TAG} 标记（标记被删则本检查静默失效）`)
    }

    if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      problems.push(`${at(declaration)} \`${name}\` 不得声明为 async —— 原子段不能让出控制权`)
    }

    for (const awaitNode of ownScopeAwaits(declaration)) {
      problems.push(
        `${at(awaitNode)} \`${name}\` 自身作用域内出现 await —— `
        + '检查与扣减之间一旦让出控制权，并发请求会读到同一旧计数而击穿配额（铁律 14）'
      )
    }
  }

  // —— 检查 3：配额计数的写入点 ——
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && isQuotaCounterTarget(node.left)) {
      const owner = enclosingNamedFunction(node)

      if (!owner || !QUOTA_WRITER_ALLOWLIST.includes(owner)) {
        problems.push(
          `${at(node)} 在 ${owner ? `\`${owner}\`\` ` : '模块顶层'}里直接写配额计数 `
          + `\`${node.left.getText(sourceFile)}\` —— 只允许 ${QUOTA_WRITER_ALLOWLIST.join(' / ')} 写`
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)

  return { problems }
}

/** 与检查器同源的事实：这些名字必须出现在被检文件里（供测试断言，不是第二份实现） */
export const ATOMIC_INVARIANTS = {
  atomicFunctions: ATOMIC_FUNCTIONS,
  quotaWriterAllowlist: QUOTA_WRITER_ALLOWLIST,
  atomicTag: ATOMIC_TAG
}

async function main() {
  const target = process.argv[2] ?? 'server/relay-state.js'
  const source = await readFile(new URL(`../${target}`, import.meta.url), 'utf8')
  const { problems } = checkAtomicInvariants(source, target)

  if (problems.length === 0) {
    console.log(`[check:atomic] OK —— ${ATOMIC_FUNCTIONS.length} 个原子函数无 await，配额计数写入点均在白名单内（${target}）`)
    return
  }

  console.error(`[check:atomic] 发现 ${problems.length} 处违反并发不变量的写法：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
