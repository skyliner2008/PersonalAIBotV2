$filePath = "c:\Users\MSI\PersonalAIBotV2\server\src\bot_agents\tools\index.ts"
$lines = Get-Content -Path $filePath -Encoding UTF8

function SetLine($idx, $newContent) {
    if ($idx -lt $lines.Count) {
        $lines[$idx] = $newContent
    }
}

SetLine 29 '  description: "บอกเวลาปัจจุบันของระบบ เพื่อช่วยจัดตารางงานหรืออ้างอิงเวลา",'
SetLine 39 '  description: "พิมพ์ข้อความออกทางหน้าจอ Console ของเครื่องที่รันบอทอยู่ (ใช้ debug หรือแจ้งเตือนฝั่ง server)",'
SetLine 43 '      message: { type: Type.STRING, description: "ข้อความที่ต้องการพิมพ์" },'
SetLine 51 '  console.log(`🤖 [AI SAY]: ${message}`);'
SetLine 52 '  return "พิมพ์ข้อความสำเร็จแล้ว";'
SetLine 59 '  description: "ส่งไฟล์จากคอมพิวเตอร์ไปยังแชทของผู้ใช้ (Telegram/LINE). ใช้เมื่อผู้ใช้ขอไฟล์หรือเอกสาร",'
SetLine 65 '        description: "พาธของไฟล์ที่ต้องการส่ง (เช่น ''C:\\test.txt'')",'
SetLine 69 '        description: "คำอธิบายไฟล์ที่จะส่งไปพร้อมกัน (ถ้ามี)",'
SetLine 142 '  description: "ค้นหาข้อมูลจากความทรงจำระยะยาว (Archival Memory) ของผู้ใช้ ใช้เมื่อต้องการดึงข้อมูลเก่าที่เคยคุยกัน เช่น ชื่อ งาน สิ่งที่ชอบ",'
SetLine 146 '      query: { type: Type.STRING, description: "คำค้นหา เช่น ''ชื่อผู้ใช้'', ''งานอดิเรก'', ''อาหารที่ชอบ''" },'
SetLine 154 '  description: "บันทึกข้อเท็จจริงใหม่เกี่ยวกับผู้ใช้ลงในความทรงจำระยะยาว ใช้เมื่อผู้ใช้บอกข้อมูลเกี่ยวกับตนเอง เช่น ชื่อ อาชีพ ความชอบ",'
SetLine 158 '      fact: { type: Type.STRING, description: "ข้อเท็จจริงที่ต้องการบันทึก เช่น ''ผู้ใช้ชื่อ สมชาย ทำงานเป็นวิศวกร''" },'

SetLine 267 "      if (facts.length === 0) return '🧠 ไม่พบข้อมูลที่เกี่ยวข้องในความทรงจำ';"
# Fixed escaping for backticks in JS template string
SetLine 268 '      return `🧠 ข้อมูลที่พบ:\n${facts.map((f, i) => `${i + 1}. ${f}`).join(''\n'')}`;'
SetLine 273 '      return `✅ บันทึกลงความทรงจำแล้ว: "${fact}"`;'

$lines | Set-Content -Path $filePath -Encoding UTF8
