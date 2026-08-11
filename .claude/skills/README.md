# Skills

Заготовка для кастомных скиллов Claude Code.

Каждый скилл — это отдельная папка с файлом `SKILL.md` внутри:

```
.claude/skills/
└── <skill-name>/
    └── SKILL.md
```

`SKILL.md` должен начинаться с YAML-заголовка:

```markdown
---
name: skill-name
description: Когда использовать этот скилл (важно для автоматического выбора).
---

Инструкции для скилла...
```

Подробнее: https://code.claude.com/docs/en/skills
