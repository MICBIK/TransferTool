import { onBeforeUnmount, onMounted, ref } from 'vue';

/** 窄屏（手机）判定，随窗口变化更新。 */
export function useNarrow(maxWidth = 768) {
  const narrow = ref(window.innerWidth < maxWidth);
  const onResize = () => (narrow.value = window.innerWidth < maxWidth);
  onMounted(() => window.addEventListener('resize', onResize));
  onBeforeUnmount(() => window.removeEventListener('resize', onResize));
  return narrow;
}
