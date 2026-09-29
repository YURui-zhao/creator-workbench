/**
 * 达人业务规则常量（V3-alpha P3）
 *
 * 唯一来源：P1（复投雷达达标判定）与 P3（价格判断）必须共用同一个 TARGET_CPM，
 * 不允许出现第二个可漂移的 30。本模块只做常量提取，不含任何逻辑。
 */

// 目标 CPM：单次合作累计 CPM <= 该值视为达标（P1），也是 P3 目标价的换算基准
export const TARGET_CPM = 30

// 星图刊例价的常规折扣参考（业务经验值，非保证）
export const REGULAR_XINGTU_DISCOUNT_RATE = 0.7

// 当前业务经验的最低参考边界（不是系统硬下限，也不用于 clamp 目标价）
export const MIN_REFERENCE_DISCOUNT_RATE = 0.2

// 价格规则版本：口径变化时必须升级，便于未来决策记录追溯当时依据
export const PRICING_VERSION = 'creator-pricing-v1'
