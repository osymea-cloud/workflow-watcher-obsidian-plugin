
# workflow watcher 
**ZH ver**
- 基于工作流的obsidian文件看板 
- 工作流修改灵活，适合探索性任务
- 重视数据统计与复盘，开启正计时器 
- 绘制日期-数据折线图
- 9种主题，随心情切换
- 依靠json存储，无忧迁移

**EN ver**
- Workflow-based Obsidian file dashboard
- Workflow is flexible to modify, suitable for exploratory tasks
- Focus on data statistics and review, with positive timer available
- Plot date-data line chart
- 9 themes to switch according to your mood
- Data stored in JSON, hassle-free migration

**Board**

![mainboard](./doc/main_board-0.jpeg)

**Menu**

![nav](./doc/bar_board-0.jpeg)

# README.md content

```mermaid
mindmap
  root(workflow watcher | 工作流监视器)
    数据 | Data
      工作流 | Workflow
        树状结构 | Tree Structure
        泳道图 | Swimlane Diagram
        进行中/完成/取消三种状态 | 3 Status: In Progress / Done / Cancelled
        多个工作流展示在一个看板 | Multiple workflows on one dashboard
        灵活的导入/导出结构 | Flexible import & export structure
        额外的无工作流属性的节点 | Extra non-workflow node
        添加概要/想法/回顾/tag | Add summary / idea / review / tag
      工作流节点 | Workflow Node
        卡片 | Card
        未开始/进行中/完成/受阻/取消五种状态样式 | 5 Status Style: Todo / In Progress / Done / Blocked / Cancelled
        折叠子树 | Collapse subtree
        进度条（填写分子与分母） | Progress bar (numerator & denominator)
        自动填写开始与截止日期（默认一周） | Auto fill start & due date (default 1 week)
        基于yaml标签添加链接文件 | Link files via yaml tags
        正计时器记录专注时间 | Positive timer for focus time
        显示专注时间 | Display focus time
        生成热力图/甘特图 | Generate heatmap / Gantt chart
        查看重要-紧急四象限 | View Eisenhower Matrix
        为每个节点添加备注与待办 | Add notes & todos for each node
        将已完成子树归档到新看板 | Archive completed subtree to new dashboard
        拖动卡片修改节点顺序 | Drag card to reorder nodes
    功能 | Features
      主题 | Theme
        深色/浅色 | Dark / Light
        默认/科技/自然/杂志/复古/波点/网页/清新/少女9种主题 | 9 themes: Default / Tech / Nature / Magazine / Retro / Dots / Web / Fresh / Sweet
      灵活 | Flexibility
        json记录工作流结构 | JSON stores workflow structure
        yaml表头筛选链接文档 | Filter linked docs by yaml frontmatter
        一个json文件是一个看板 | One JSON file = one dashboard
        使用json灵活导入/导出数据 | Flexible import & export via JSON
        将已完成子树归档至新json | Archive completed subtree into new JSON
      专注 | Focus
        引导性标题 | Guiding title
        开启节点正计时器 | Start node focus timer
      日程 | Schedule
        重要-紧急四象限视图 | Eisenhower Matrix view
        开始/完成日志 | Start / completion log
        无工作流属性的节点 | Non-workflow node
      统计 | Statistics
        生成专注时间热力图/甘特图 | Generate focus heatmap / Gantt chart
        绘制日期-数据CSV折线图 | Plot date-data CSV line chart
    快速开始 | Quick Start
      开启看板 | Open Dashboard
        打开看板 | Load dashboard
        新建工作流 | New workflow
        新增节点 | Add node
      使用功能 | Use Features
        链接仓库文档 | Link repository documents
        开始专注正计时 | Start focus timer
        在仓库间迁移 | Migrate between repositories
```

![ZHcontent](./doc/屏幕截图%202026-11-23%20105119.jpg)

![ENcontent](./doc/屏幕截图%202026-11-23%20105112.jpg)


# goto README.md (a lot of pictures) 
[learn_more](./READMEinside.md)