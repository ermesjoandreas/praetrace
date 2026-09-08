<template>
  <section class="card">
    <logo />
    <slot name="body" />
  </section>
</template>

<script>
import Logo from './Logo.vue';

export default {
  name: 'TheStatusCard',
  components: { Logo },
  data() {
    return { count: 0 };
  },
};
</script>
