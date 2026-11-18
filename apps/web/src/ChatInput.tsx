import { Input } from "@chatui/core/es/components/Input/index.js";
import type { ComponentProps } from "react";

export default function ChatInput(props: ComponentProps<typeof Input>) {
  return <Input {...props} autoSize minRows={1} maxRows={4} showCount={false} />;
}
