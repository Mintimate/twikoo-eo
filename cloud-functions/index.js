/** Makers 按源码识别路由方法，必须显式声明 onRequest，不能仅 re-export。 */
import { onRequest as handleRequest } from '../dist/twikoo.js'

export function onRequest (context) {
  return handleRequest(context)
}
