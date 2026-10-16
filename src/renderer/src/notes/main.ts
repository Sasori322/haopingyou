import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

// 一个窗口 = 一张便签。自己是哪一张由主进程在 URL 上带过来（`?id=n_xxx`）。
createApp(App).mount('#app')
