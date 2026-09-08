<!-- The <script> in this comment is here on purpose: a splitter that reads a
     comment finds the wrong block, and every line number after it is wrong. -->
<template>
  <div class="app">
    <template v-if="ready">
      <StatusCard :title="title" />
      <sidebar-item v-for="item in items" :key="item.id" />
    </template>
    <table>
      <tr v-for="row in rows" :key="row.id">
        <td>{{ row.name }}</td>
      </tr>
    </table>
  </div>
</template>

<script setup lang="ts">
import type { Table } from './types';

import StatusCard from './StatusCard.vue';
import { SidebarItem } from './widgets';

const title = 'Codemap';
const rows: Table[] = [];
const items = load();

function load(): string[] {
  return [];
}
</script>

<style scoped>
.app {
  display: grid;
}
</style>
