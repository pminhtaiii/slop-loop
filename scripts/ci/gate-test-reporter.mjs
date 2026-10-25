import { gateTestProgressLine } from '../agents/workflow-gate-progress.mjs';

export default async function* gateTestReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:start' && event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const line = gateTestProgressLine(event.type, event.data?.name, event.data?.file);
    if (line) yield line;
  }
}
