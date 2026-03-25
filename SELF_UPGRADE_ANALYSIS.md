# Self-Upgrade System & Second Brain — Analysis & Improvement Plan

> วิเคราะห์ระบบ Self-Upgrade System และ Second Brain เปรียบเทียบกับระบบ Claude-level

---

## สถานะปัจจุบัน (Current Maturity: ~65%)

| Component | Maturity | จุดแข็ง | จุดอ่อนหลัก |
|-----------|----------|---------|------------|
| **Scanning Pipeline** | 70% | Static + LLM hybrid analysis | Single-file only, ไม่มี cross-file analysis |
| **Implementation Pipeline** | 65% | Planning → Code → Test → Boot verify | Test quality ไม่ถูกตรวจ, single-file edits only |
| **Second Brain (Codebase Map)** | 60% | Dependency graph + embeddings | ไม่มี call graph, stale embeddings |
| **Test Generator** | 50% | Vitest integration | ไม่ตรวจ assertion quality, vacuous tests ผ่านได้ |
| **Learning Journal** | 65% | Semantic search + confidence | ไม่มี temporal decay, async race conditions |
| **Self-Healing** | 55% | Auto model downgrade | ไม่หา root cause, thresholds แข็งตัว |
| **Self-Reflection** | 60% | Periodic auto-analysis | Shallow pattern matching, ไม่ action ผลลัพธ์ |
| **Impact Analysis** | 55% | Multi-hop BFS dependency walk | Regex-based export extraction, ไม่มี dataflow |
| **Vector Store** | 60% | Cosine similarity, file-based | In-memory brute-force, ไม่ scale |

---

## ส่วนที่ 1: ปัญหาระดับ Critical (แก้ก่อน)

### 1.1 LLM Scan ส่งไฟล์ทั้งหมดเข้า prompt — ไม่มี chunking

**ปัจจุบัน:** `analyzeBatchWithLLM()` ส่งเนื้อหาไฟล์ทั้งไฟล์ (สูงสุด 100KB) เข้า prompt เดียว
**ปัญหา:** ไฟล์ใหญ่เกิน context window → LLM ตัดข้อมูลท้ายๆ ออก → พลาด bug ที่อยู่ท้ายไฟล์
**Claude ทำอย่างไร:** ใช้ chunking + sliding window, วิเคราะห์ทีละ function/class

**แนวทางแก้ไข:**
```
- ใช้ AST (ts-morph) แยกไฟล์เป็น function-level chunks
- ส่ง chunk ทีละ function พร้อม context ของ imports + types
- รวมผลวิเคราะห์จากทุก chunk
- เมื่อไฟล์ < 2000 tokens → ส่งทั้งไฟล์เหมือนเดิม
```

### 1.2 Test Generator ไม่ตรวจคุณภาพ test

**ปัจจุบัน:** `runGeneratedTest()` ใช้ `--passWithNoTests` → test ที่ไม่มี assertion ก็ผ่าน
**ปัญหา:** AI สร้าง test ที่ import แล้ว pass โดยไม่ assert อะไรเลย → ไม่จับ bug จริง

**แนวทางแก้ไข:**
```
- ลบ --passWithNoTests flag
- ตรวจ test output ว่ามี assertion ผ่าน >= 1 (parse vitest output)
- เพิ่ม minimum assertion count check (อย่างน้อย 2 assertions)
- เพิ่ม negative test case: test ต้อง fail กับ original code
- คำนวณ coverage % สำหรับ changed lines
```

### 1.3 Implementation เป็น Single-File Only

**ปัจจุบัน:** `implementProposalById()` อ่านและแก้ไขไฟล์เดียว
**ปัญหา:** Bug หลายตัวต้องแก้หลายไฟล์ (เช่น เพิ่ม export ใน A + import ใน B)

**แนวทางแก้ไข:**
```
- ใช้ filesToEdit จาก ImplementationPlan (มีอยู่แล้วแต่ไม่ถูกใช้!)
- สร้าง atomic multi-file transaction: backup ทุกไฟล์ → แก้ → verify → commit/rollback
- ใช้ AST tools (ast_replace_function, ast_add_import) สำหรับ cross-file edits
```

### 1.4 ไม่มี Rollback อัตโนมัติเมื่อ TSC/Boot fail

**ปัจจุบัน:** เมื่อ implementation fail → reject proposal → ไฟล์อาจค้างในสถานะเสีย
**ปัญหา:** ถ้า AI แก้ไฟล์แล้ว TSC fail → ไฟล์ยังเป็น version ที่พัง

**แนวทางแก้ไข:**
```
- ก่อน implement: git stash หรือ backup ทุกไฟล์ที่จะแก้
- เมื่อ verify fail: restore จาก backup อัตโนมัติ
- เพิ่ม: ถ้า rollback สำเร็จ → ส่ง error กลับ AI ให้ลองอีกครั้ง (retry with error context)
```

---

## ส่วนที่ 2: Second Brain ต้องเสริม

### 2.1 ไม่มี Call Graph (ใครเรียกใคร)

**ปัจจุบัน:** `codebase_edges` เก็บแค่ import relationships
**ปัญหา:** รู้แค่ "A imports B" แต่ไม่รู้ "function X() calls B.doThing()"
**ทำไมสำคัญ:** เมื่อแก้ function signature → ต้องรู้ว่า callers ที่ไหนบ้างต้องอัปเดต

**แนวทางแก้ไข:**
```
DB Schema เพิ่ม:
  codebase_calls (
    caller_file TEXT,
    caller_function TEXT,
    callee_file TEXT,
    callee_function TEXT,
    call_type TEXT,  -- 'direct' | 'callback' | 'await'
    line_number INTEGER
  )

Build ด้วย ts-morph:
  - Walk AST ของทุกไฟล์
  - จับ CallExpression nodes
  - Resolve ว่าเรียก function จากไฟล์ไหน
```

### 2.2 ไม่มี Type Information ใน Codebase Map

**ปัจจุบัน:** `exports_json` เก็บแค่ชื่อ symbol (string[])
**ปัญหา:** AI ไม่รู้ function signature → แก้ parameter ผิด → compile error

**แนวทางแก้ไข:**
```
exports_json เปลี่ยนเป็น:
[
  { "name": "getDb", "kind": "function", "signature": "() => Database" },
  { "name": "setSetting", "kind": "function", "signature": "(key: string, value: string) => void" },
  { "name": "TaskType", "kind": "enum", "members": ["GENERAL", "CODE", ...] }
]

ใช้ ts-morph extractSignature() จาก FunctionDeclaration
```

### 2.3 Embeddings ไม่ Update เมื่อไฟล์เปลี่ยน

**ปัจจุบัน:** `updateCodeEmbeddings()` สร้าง embedding ครั้งเดียว → ไม่ update เมื่อไฟล์ถูกแก้
**ปัญหา:** Semantic search หาไฟล์ที่ "คล้ายกัน" ด้วยข้อมูลเก่า → ผลลัพธ์ผิด

**แนวทางแก้ไข:**
```
- เพิ่ม hash column ใน codebase_embeddings (MD5 ของ summary)
- เมื่อ scan → เทียบ hash → re-embed เฉพาะไฟล์ที่เปลี่ยน
- เพิ่ม TTL: re-embed ไฟล์ที่เก่ากว่า 7 วัน
```

### 2.4 Vector Search เป็น Brute-Force

**ปัจจุบัน:** `searchSimilarFiles()` load ทุก embedding → cosine similarity ทุกตัว
**ปัญหา:** O(n) ทุกครั้ง → ช้าเมื่อมี 1000+ ไฟล์

**แนวทางแก้ไข (ระยะสั้น):**
```
- เพิ่ม in-memory index cache (load ครั้งเดียว, invalidate เมื่อ upsert)
- ใช้ approximate search: random projection หรือ product quantization
```

---

## ส่วนที่ 3: Prompt Engineering ต้องปรับปรุง

### 3.1 Scan Prompt (analyzeBatchWithLLM)

**ปัจจุบัน (คะแนน: 7/10):**
- ดี: มี "WHAT TO NEVER REPORT" ชัดเจน → ลด false positives
- ดี: มี confidence threshold
- แย่: ไม่มี output examples → LLM อาจส่ง format ผิด
- แย่: ไม่มี codebase context → LLM ไม่รู้ว่า function ถูกเรียกจากที่ไหน

**ปรับปรุง:**
```
เพิ่มใน prompt:
1. "Related files that import this module: [list from codebase_edges]"
2. "Known exported symbols and their types: [from codebase_map]"
3. Few-shot example: แสดง JSON output ตัวอย่าง 1 ตัว
4. "If the file uses optional chaining (?.) on a value, that value IS being null-checked"
```

### 3.2 Implementation Prompt

**ปัจจุบัน:** ส่ง plan + original code + proposal → AI แก้
**ปัญหา:** ไม่มี "past failure context" ที่เจาะจงพอ

**ปรับปรุง:**
```
เพิ่ม:
1. "CRITICAL: These exact changes FAILED before: [past rejected proposals for same file]"
2. "Test that MUST pass after your change: [test assertions]"
3. "Do NOT modify these functions: [exported functions used by other files]"
4. Import map: "Available imports from this project: [auto-generated from codebase_map]"
```

### 3.3 Test Generation Prompt

**ปัจจุบัน (คะแนน: 5/10):**
- แย่: Prompt กว้างเกินไป "generate a COMPLETE test file"
- แย่: ไม่บอกว่า test ต้อง assert อะไร
- แย่: ไม่มี negative test cases

**ปรับปรุง:**
```
เพิ่มใน prompt:
1. "You MUST include at least 3 assertions using expect()"
2. "Include a NEGATIVE test: verify the bug behavior is gone"
3. "Test the SPECIFIC lines that changed (lines X-Y)"
4. "Mock these external dependencies: [list from imports]"
5. "DO NOT test by just importing — you must call the function and assert output"
```

---

## ส่วนที่ 4: Learning System ต้องฉลาดขึ้น

### 4.1 ไม่มี Negative Learning

**ปัจจุบัน:** เรียนรู้แค่ "ทำอะไรสำเร็จ" ไม่เรียน "ทำอะไรแล้วพัง"
**Claude ทำอย่างไร:** เก็บ failed patterns เป็น "anti-patterns" ที่ต้องหลีกเลี่ยง

**แนวทางแก้ไข:**
```
เมื่อ proposal ถูก reject:
1. วิเคราะห์ error message → สร้าง learning ประเภท "anti_pattern"
2. เก็บ: { pattern: "อย่าแก้ export signature ของ X", reason: "TSC error...", file: "..." }
3. เมื่อ implement ไฟล์เดียวกัน → inject anti-patterns เข้า prompt
```

### 4.2 Confidence ไม่สะท้อนความจริง

**ปัจจุบัน:** `applyLearning()` เพิ่ม confidence +0.05 ทุกครั้งที่ใช้
**ปัญหา:** ใช้บ่อย ≠ ถูกต้อง — learning ที่ใช้ 10 ครั้งแต่ fail 8 ครั้ง ยังมี confidence สูง

**แนวทางแก้ไข:**
```
เปลี่ยนเป็น success-based confidence:
  confidence = (successful_applies / total_applies) * base_confidence

เพิ่ม columns:
  successful_applies INTEGER DEFAULT 0,
  failed_applies INTEGER DEFAULT 0
```

### 4.3 ไม่มี Temporal Decay

**ปัจจุบัน:** Learning เก่า 6 เดือน กับ learning ใหม่วันนี้ มี weight เท่ากัน
**แนวทางแก้ไข:**
```
effective_confidence = confidence * decay_factor
decay_factor = exp(-days_since_last_apply / 30)  // half-life 30 days
```

---

## ส่วนที่ 5: Verification Pipeline ต้องเข้มขึ้น

### 5.1 TSC Baseline Comparison ไม่แม่นยำ

**ปัจจุบัน:** เปรียบเทียบ error strings ก่อน/หลัง → ถ้ามี error ใหม่ = fail
**ปัญหา:** Error message เดียวกันอาจ word ต่างกัน → false positive

**แนวทางแก้ไข:**
```
- Parse TSC output เป็น structured: { file, line, code, message }
- เปรียบเทียบด้วย error code (TS2304, TS2339...) ไม่ใช่ message text
- ยอมรับ: error ที่อยู่ใน baseline → ไม่ใช่ error ใหม่
```

### 5.2 Runtime Boot Test แค่เช็ค /health

**ปัจจุบัน:** Start server → fetch /health → ถ้า 200 = pass
**ปัญหา:** Server boot ได้แต่ feature หลักพัง

**แนวทางแก้ไข:**
```
เพิ่ม smoke test endpoints:
1. /health → server alive
2. /api/upgrade/status → self-upgrade system works
3. /api/models → model routing works
4. ลอง WebSocket connect → realtime works
```

### 5.3 ไม่มี Regression Detection

**ปัจจุบัน:** ตรวจแค่ "ไม่มี error ใหม่"
**ปัญหา:** Performance regression, memory leak → ไม่ถูกจับ

**แนวทางแก้ไข (ระยะยาว):**
```
- เก็บ baseline metrics: boot time, memory usage, response time
- หลัง implement: เทียบ metrics → ถ้าแย่ลง > 20% = warn
```

---

## ส่วนที่ 6: Concurrency & Safety

### 6.1 ไม่มี File-Level Locking

**ปัจจุบัน:** 2 proposals สามารถแก้ไฟล์เดียวกันพร้อมกันได้
**แนวทางแก้ไข:**
```
- เพิ่ม file lock map: Map<filePath, proposalId>
- ก่อน implement: acquire lock → ถ้า locked → queue
- หลัง implement: release lock
```

### 6.2 Vector Index Corruption

**ปัจจุบัน:** `saveToDisk()` เขียน JSON ทั้งไฟล์ → ถ้า process crash ระหว่างเขียน = corrupt
**แนวทางแก้ไข:**
```
- เขียนไป temp file ก่อน → rename (atomic operation)
- เพิ่ม checksum verification เมื่อ load
```

---

## ส่วนที่ 7: Feature เทียบเท่า Claude ที่ยังไม่มี

| Feature | Claude มี | ระบบปัจจุบัน | ความยาก |
|---------|----------|-------------|---------|
| **Multi-file atomic edits** | ✅ | ❌ | Medium |
| **Call graph analysis** | ✅ | ❌ | Medium |
| **Type-aware refactoring** | ✅ | Partial (ts-morph) | Low |
| **Iterative self-correction** | ✅ (retry with error) | ❌ | Medium |
| **Test-driven implementation** | ✅ (write test first) | ❌ (test after) | Medium |
| **Context-aware chunking** | ✅ | ❌ | Medium |
| **Structured output (tool_use)** | ✅ | ❌ (regex JSON parse) | Low |
| **Memory management** | ✅ (token budgets) | Partial (16K budget) | Low |
| **Negative examples in prompts** | ✅ | ❌ | Low |
| **Parallel tool execution** | ✅ | ❌ | High |

---

*Generated: 2026-03-24*
