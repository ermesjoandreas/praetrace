<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <li class="sidebar-item">{{ label }}</li>
</template>
