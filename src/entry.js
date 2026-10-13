/** 构建入口；公开工厂供无网络回归测试，生产入口延迟连接 Blob。 */
import { createHandler } from './handler.js'
export { createHandler } from './handler.js'
export const onRequest = createHandler()
export default onRequest
