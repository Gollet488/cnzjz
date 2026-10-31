import { createApp } from 'vue';
import App from './App.vue';
import { installUI } from './ui';
import './style.css';
const app = createApp(App);
installUI(app);
app.mount('#app');
