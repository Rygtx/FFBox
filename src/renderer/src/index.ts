import { createApp } from 'vue';
import App from './App/App.vue';
import { createPinia, setActivePinia } from 'pinia';

const pinia = createPinia();
setActivePinia(pinia);  // App 在构建过程中，顶层就 import 了 store，所以要在 createApp 之前就初始化好

const app = createApp(App);
// app.config.performance = true;
app.mount('#app');
// app.use(pinia);
