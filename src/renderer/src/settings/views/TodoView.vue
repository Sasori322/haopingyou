<script setup lang="ts">
// M3 将接入：待办 CRUD、便签速记、拖拽排序、截止提醒。
</script>

<template>
  <h2 class="page-title">待办与便签</h2>
  <p class="page-desc">
    数据保存在用户目录下的独立 JSON 文件（原子写入），所有写操作都串行化在主进程，渲染进程不会直连存储。
    数据访问统一走 Repository 接口，将来若需要全文检索可以平滑替换为 SQLite。
  </p>

  <el-card shadow="never">
    <el-empty description="待办与便签界面将在后续版本上线">
      <template #description>
        <div class="placeholder-note">
          <div>规划中的能力：</div>
          <div>· 待办：标题、优先级、标签、截止时间、拖拽排序、完成统计</div>
          <div>· 便签：速记、置顶、颜色标记</div>
          <div>· 与宠物联动：宠物右键即可快速添加一条待办</div>
          <div>· 旁挂小面板：常驻显示今日未完成项（独立窗口，不放大宠物窗口的拦截面积）</div>
        </div>
      </template>
    </el-empty>
  </el-card>
</template>
