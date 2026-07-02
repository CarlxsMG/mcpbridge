<script setup lang="ts"></script>

<template>
  <section class="not-found">
    <h1>Page not found</h1>
    <p><RouterLink to="/servers" class="btn-secondary">Back to Servers</RouterLink></p>
  </section>
</template>

<style scoped>
.not-found {
  text-align: center;
  padding: 4rem 1rem;
}
</style>
