// 老浏览器兜底（《实施计划》步骤 3.4；口径见《决策记录》六-10）
// 为什么需要这一层：支持口径是"Chrome / Edge 90 以上"，而打包进来的依赖里仍有**现代 API 的裸调用**
//   （实测扫出来的是 `Object.hasOwn`，Chrome 93 才有；pdf.js 的 legacy 构建只降级语法、不补全所有 API）。
//   语法由 esbuild 按 target: es2020 降级，**API 只能靠运行时补齐** —— 就是这里。
// 两条纪律：
//   ① **只在缺失时定义**，绝不覆盖原生实现（原生实现更快、语义更准）；
//   ② 不补 `structuredClone` 这类"简化实现会改变语义"的 API —— JSON 往返会丢掉 Map / Set / ArrayBuffer
//      与循环引用，补上反而制造更难查的问题。那种情况宁可让 `npm run test:browser` 把裸调用拦下来。
// 加载时机：`src/main.js` 的第一条 import —— 模块副作用先于任何业务代码执行。
export function installPolyfills(env = globalThis) {
  const installed = []
  const Obj = env.Object || Object
  const Arr = env.Array || Array
  const proto = Arr.prototype

  if (typeof Obj.hasOwn !== 'function') {
    Obj.hasOwn = function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key)
    }
    installed.push('Object.hasOwn')
  }

  if (typeof proto.at !== 'function') {
    proto.at = function at(index) {
      const len = this.length >>> 0
      let i = Math.trunc(index) || 0
      if (i < 0) i += len
      return i < 0 || i >= len ? undefined : this[i]
    }
    installed.push('Array.prototype.at')
  }

  if (typeof proto.findLast !== 'function') {
    proto.findLast = function findLast(predicate, thisArg) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (predicate.call(thisArg, this[i], i, this)) return this[i]
      }
      return undefined
    }
    installed.push('Array.prototype.findLast')
  }

  if (typeof proto.findLastIndex !== 'function') {
    proto.findLastIndex = function findLastIndex(predicate, thisArg) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (predicate.call(thisArg, this[i], i, this)) return i
      }
      return -1
    }
    installed.push('Array.prototype.findLastIndex')
  }

  const Prom = env.Promise || Promise
  if (typeof Prom.withResolvers !== 'function') {
    Prom.withResolvers = function withResolvers() {
      let resolve
      let reject
      const promise = new Prom((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
    installed.push('Promise.withResolvers')
  }

  // structuredClone：**只补"能安全补"的部分**。JSON 往返会丢掉 Map / Set / ArrayBuffer 与循环引用，
  // 而 `transfer` 参数（转移 ArrayBuffer 所有权）根本无法用简化实现模拟 —— 那种调用宁可**明确抛错**，
  // 也不要静默产生一份错的数据（沿用本项目"明确失败比静默出错好"的一贯口径，见决策 二-6）。
  // 实测用处：pdf.js 的 LoopbackPort（没有真 worker 时的假端口）会用到；我们用真 worker，一般走不到。
  if (typeof env.structuredClone !== 'function') {
    env.structuredClone = function structuredClone(value, options) {
      if (options && options.transfer && options.transfer.length) {
        throw new Error('当前浏览器不支持 structuredClone 的 transfer 参数，请升级浏览器后再试')
      }
      return JSON.parse(JSON.stringify(value))
    }
    installed.push('structuredClone')
  }

  return installed
}

// 模块加载即安装：main.js 第一条 import，保证在任何业务代码跑起来之前生效
installPolyfills()
