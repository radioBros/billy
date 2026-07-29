<script setup lang="ts">
/**
 * Root component. Just the router outlet — the AppShell layout (with <v-app>)
 * wraps protected routes, and Login provides its own <v-app>, so the router
 * decides the chrome. Kept minimal so the layout owns the shell.
 */
</script>

<template>
  <router-view />
</template>
