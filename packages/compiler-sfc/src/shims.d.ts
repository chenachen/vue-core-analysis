/**
 * 为 `merge-source-map` 提供本仓库内使用所需的最小类型声明。
 */
declare module 'merge-source-map' {
  export default function merge(oldMap: object, newMap: object): object
}
