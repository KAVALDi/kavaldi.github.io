# Модель данных

Допустимые значения всех перечислений: в `src/core/schema.mjs`. Проверка: `npm run hub -- validate`.

## Хранилище

```
knowledge/
  store.yaml                     паспорт: версия формата
  projects/<id>.md               проекты
  entities/<проект>/<файл>.md    записи
  sources/<srcId>.json           сведения об импортированном материале
  sources/raw/<srcId>.md         его текст (не изменяется)
  drafts/<draftId>.json          очередь разбора
  history/<id>/<ревизия>.md      прежние версии записей
  log/events.jsonl               журнал событий, только дописывается
  media/                         файлы и их атрибуция
```

Имя файла записи косметическое: запись находят по `id` во frontmatter. Файл можно переименовать или переложить в Obsidian.

## Проект

```yaml
---
id: redstar                # латиница через дефис. Используется в адресах
title: RedStar · Space Station 14
visibility: public         # public | private. Приватный проект не публикуется целиком
nature: game-mod           # свободная метка: game-mod, tool, …
order: 1
tagline: Одна строка для карточки
status_note: Необязательная строка о состоянии
keywords: [улей, матка]    # по ним импорт предлагает проект
public_repos: [owner/repo] # ссылки на код из других репозиториев не публикуются
links:
  - { title: Прежний сайт, url: https://… }
---
Обзор проекта в Markdown.
```

## Запись

```yaml
---
id: mech-cargowax1         # стабильный, не меняется никогда
type: mechanic             # mechanic | idea | decision | research | task | article | devlog | component
project: redstar
title: Карго, воск и свечи
slug: cargo-wax-candles    # адрес страницы. При смене старый уходит в aliases
aliases: []
summary: Одна-две строки
visibility: private        # private | public: меняется только отдельным действием
states:                    # четыре НЕЗАВИСИМЫХ измерения
  design: accepted         # unknown draft proposed accepted rejected superseded deferred
  implementation: merged   # unknown none local pr merged released
  verification: tests      # unknown none partial tests manual model
  docs: ready              # unknown none ready published stale
roadmap: { lane: done, order: 2 }   # done | now | next | later. Без поля записи нет на дорожной карте
links:
  - { rel: part-of, to: mech-beekeep01 }
code_refs:
  - { repo: red-star-server/RedStar, kind: pr, ref: "190" }   # остальное допишет hub sync
references:
  - { title: Публичный источник, url: https://… }
ingame_url: https://…      # представление "как в игре"
docs_reviewed: 2026-11-09  # когда текст последний раз сверяли с кодом
provenance:
  - { kind: decision, confidence: confirmed, date: 2026-11-08, source: src-…, note: … }
created: 2026-11-12
updated: 2026-11-12
revision: 3
---
Текст в Markdown.
```

### Связи (`links.rel`)

`relates`, `part-of`, `depends-on`, `implements`, `documents`, `decided-by`, `supersedes`, `rejects`, `evidence-for`. Обратное направление сайт показывает сам.

В тексте на другую запись ссылаются по id: `[[mech-beekeep01]]`, `[[mech-beekeep01|текст]]` или `[текст](hub:mech-beekeep01)`. Если целевая запись не опубликована, на сайте остаётся только текст.

### Происхождение (`provenance.kind`)

| Значение | Смысл |
| --- | --- |
| `verified-source` | утверждение из проверяемого источника |
| `user-idea` | идея владельца |
| `participant-idea` | идея участника обсуждения |
| `ai-suggestion` | гипотеза или предложение AI |
| `decision` | согласованное решение |
| `rejected` | отклонённый подход |
| `implementation` | реализация в коде |
| `verification` | результат проверки |
| `publication` | публикация документации |
| `discussion`, `unknown` | обсуждение. Неизвестно |

`confidence`: `confirmed`, `unconfirmed`, `unknown`. Неизвестное так и записывается: выдумывать дату или источник нельзя.

Отклонённые и заменённые подходы не удаляются: это записи с `design: rejected | superseded` и связями `rejects` / `supersedes`.

### Что остаётся внутренним у опубликованной записи

- `provenance`, имя файла, история;
- текст между `%%` и `%%` (в Obsidian это комментарий);
- разделы "Материал источника", "Дополнение из импорта", "Внутреннее", "Для себя" и любые с пометкой `(внутреннее)` в заголовке;
- разделы, где стоит только `_не заполнено_`;
- связи с неопубликованными записями;
- ссылки на код из репозиториев вне `public_repos`.

Студия показывает на странице записи, что именно увидят посетители.

## Устаревание документации

Запись считается потенциально устаревшей, если у неё задана `docs_reviewed`, а у неё самой или у записей, которые она `documents`, есть ссылка на код с датой слияния или изменения позже этой даты. Даты подтягивает `hub sync`.

Действующий пример: статья `art-beekeeping` сверена 2026-11-09, а PR #190 влит 2026-11-10: сайт показывает предупреждение со ссылкой на PR.

Чтобы снять пометку, обновите текст и поставьте новую дату сверки.

## Публичный снимок

`content/projects/<id>.json`, `content/entities/<id>.json`, `content/manifest.json` создаются экспортом и вручную не правятся. `content/site.json` (профиль на главной) правится вручную. `content/activity.json` в Git не хранится: его получает сборка.

## Изменение формата

При несовместимом изменении увеличьте `STORE_FORMAT` в `store.mjs` и добавьте миграцию. Новые необязательные поля миграции не требуют: неизвестные ключи frontmatter сохраняются при записи.
