import AdmZip from 'adm-zip';
import { Document, Packer, Paragraph } from 'docx';
import PptxGenJS from 'pptxgenjs';

const OFFICE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

function addXml(zip, name, xml) {
  zip.addFile(name, Buffer.from(xml.trim(), 'utf8'));
}

function createBlankXlsx() {
  const zip = new AdmZip();
  addXml(zip, '[Content_Types].xml', `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    </Types>`);
  addXml(zip, '_rels/.rels', `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`);
  addXml(zip, 'xl/workbook.xml', `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`);
  addXml(zip, 'xl/_rels/workbook.xml.rels', `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
    </Relationships>`);
  addXml(zip, 'xl/worksheets/sheet1.xml', `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`);
  addXml(zip, 'xl/styles.xml', `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
      <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
      <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
      <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
      <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
      <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
    </styleSheet>`);
  return zip.toBuffer();
}

export function officeTemplateMimeType(type) {
  return OFFICE_TYPES[type] || '';
}

export async function createBlankOfficeBuffer(type) {
  if (type === 'docx') {
    const document = new Document({ sections: [{ children: [new Paragraph('')] }] });
    return Packer.toBuffer(document);
  }
  if (type === 'xlsx') return createBlankXlsx();
  if (type === 'pptx') {
    const presentation = new PptxGenJS();
    presentation.author = '文档管理平台';
    presentation.subject = '在线新建演示文稿';
    presentation.title = '新建演示文稿';
    presentation.company = '文档管理平台';
    presentation.lang = 'zh-CN';
    presentation.layout = 'LAYOUT_WIDE';
    presentation.addSlide();
    return presentation.write({ outputType: 'nodebuffer' });
  }
  throw new Error('不支持的 Office 文件类型');
}
