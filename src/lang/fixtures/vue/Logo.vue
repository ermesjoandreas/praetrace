<script lang="ts">
import { defineComponent } from 'vue';

const Logo = defineComponent({
  name: 'Logo',
  props: { size: { type: Number, default: 24 } },
});

export default Logo;
</script>

<template>
  <svg :width="size" viewBox="0 0 24 24">
    <path d="M0 0h24v24H0z" />
  </svg>
</template>
