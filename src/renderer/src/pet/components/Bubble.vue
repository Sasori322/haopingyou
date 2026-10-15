<script setup lang="ts">
defineProps<{
  text: string
  leaving?: boolean
}>()
</script>

<template>
  <div class="bubble" :data-leaving="leaving ? 'true' : 'false'">{{ text }}</div>
</template>
