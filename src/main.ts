import { createApp } from 'vue';
import { ElButton, ElDialog, ElDrawer, ElSlider, ElSwitch, ElTooltip, ElSelect, ElOption, ElInputNumber } from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import './style.css';
const app = createApp(App);
for (const component of [ElButton, ElDialog, ElDrawer, ElSlider, ElSwitch, ElTooltip, ElSelect, ElOption, ElInputNumber]) app.use(component);
app.mount('#app');
