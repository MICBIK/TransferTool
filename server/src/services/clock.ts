/** 可注入的时钟（毫秒时间戳），便于测试时间相关逻辑。 */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
