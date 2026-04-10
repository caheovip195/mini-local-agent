# Local Agent Coder (VSCode Extension)

Extension nay la ban "mini-Cline" cho local model qua LM Studio, co:

- Plan mode (tao ke hoach truoc khi code)
- Agent mode (plan + execute tu dong)
- Tooling co ban: list/read/search/write file + run command
- LoopGuard: chan lap action lien tuc
- QuestionGuard: han che hoi ngu/hoi lan man (ep agent tu tim truoc)
- MemoryGuard: luu history theo workspace + preflight summary truoc moi request
- System prompt bo sung de bat buoc "investigate -> execute"

## 1) Cai dat

```bash
npm install
npm run compile
```

Mo thu muc nay trong VSCode, sau do nhan `F5` de chay Extension Development Host.

## 2) Cau hinh LM Studio

Vao VSCode Settings, tim `localAgent`:

- `localAgent.lmStudio.baseUrl`: mac dinh `http://127.0.0.1:1234/v1`
- `localAgent.lmStudio.apiKey`: mac dinh rong (`""`), phai dat token neu bat auth trong LM Studio
- `localAgent.lmStudio.model`: ten model dang load trong LM Studio
- `localAgent.provider.apiMode`: mac dinh `lm_rest_chat` de dung duoc thinking + mcp integrations native cua LM Studio
- `localAgent.maxTurnsPerStep`: gioi han so turn/step
- `localAgent.maxAskUser`: gioi han so lan duoc phep hoi user
- `localAgent.minInvestigationsBeforeExecute`: so lan toi thieu phai list/search/read truoc khi write/run/complete
- `localAgent.systemPromptExtra`: prompt system bo sung

## 3) Cach dung

- Mo sidebar **Local Agent**
- Nhap **LM Studio URL** (vd `http://127.0.0.1:1234/v1`)
- Chon model truc tiep tu dropdown (lay tu LM Studio `/models`)
- Nhap task
- Bam `Plan Only` de tao plan
- Bam `Run Agent` de chay plan + thuc thi
- Theo doi realtime:
  - **Plan Progress**: biet dang o step nao
  - **Agent Activity**: action nao dang chay/bi block/recovery
  - **Token Usage**: prompt/completion/total token
  - **History**: luu cac request truoc do, co nut `Use Prompt` de nap lai

Neu khong load duoc model:
- Kiem tra URL co dung endpoint `/v1` chua
- Bam `Reload Models`

Hoac dung Command Palette:

- `Local Agent: Create Plan Only`
- `Local Agent: Run Task (Plan + Execute)`

## 4) Co che chong loop / hoi ngu

Agent prompt da co cac rang buoc:

- Khong duoc output markdown, chi duoc output JSON action
- Khong duoc hoi user neu chua tu list/search/read code
- Neu bi thieu thong tin thi phai tu dat gia dinh hop ly va tiep tuc
- Neu lap lai cung action nhieu lan -> LoopGuard chen feedback bat buoc doi chien luoc
- Neu model lien tuc tra JSON loi hoac lap action -> Recovery mode tu dong list/read/search de pha loop
- Tu dong cat gon history turn de model 4-7B it bi roi context
- Truoc moi lan Plan/Run deu co 1 preflight request de tom tat history + request hien tai roi moi thuc thi

## 5) Neu chi thay plan ma khong thay execute

Ban can bam `Run Agent` (khong phai `Plan Only`).
`Plan Only` chi tao ke hoach, khong sua code, khong chay command.

Ban co the tang do \"cung\" bang `localAgent.systemPromptExtra`, vi du:

```
Never ask user about coding details that can be inferred from repository.
If uncertain, implement the safest assumption and continue.
Avoid repeating the same tool action with the same arguments.
```

## 6) Gioi han hien tai

Day la ban MVP da chay duoc. Chua co:

- Browser/tool calling phuc tap nhu Cline day du
- Diff preview UI truoc khi ghi file
- MCP connector

Neu can, co the mo rong tiep: patch mode, edit preview, multi-agent, memory theo repo.
