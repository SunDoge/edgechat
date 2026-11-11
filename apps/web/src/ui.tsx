import {
  Button as AriaButton,
  Input as AriaInput,
  Label,
  TextField as AriaTextField,
  type ButtonProps,
  type InputProps,
  type TextFieldProps,
} from "react-aria-components";

type ActionButtonProps = Omit<ButtonProps, "className"> & {
  variant?: "primary" | "quiet" | "icon";
  className?: string;
};

export function ActionButton({ variant = "primary", className = "", ...props }: ActionButtonProps) {
  const variants = {
    primary: "bg-brand px-3 font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300",
    quiet: "px-3 font-medium text-ink hover:bg-neutral-100",
    icon: "grid size-10 place-items-center rounded-full text-ink hover:bg-neutral-100",
  } as const;
  return <AriaButton {...props} className={`h-11 rounded-lg text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${variants[variant]} ${className}`} />;
}

type TextInputProps = Omit<TextFieldProps, "children" | "className"> & {
  label: string;
  inputProps?: Omit<InputProps, "className">;
};

export function TextInput({ label, inputProps, ...props }: TextInputProps) {
  return <AriaTextField {...props} className="group grid gap-1.5 text-sm font-medium text-ink">
    <Label>{label}</Label>
    <AriaInput {...inputProps} className="h-11 rounded-lg bg-white px-3 text-base font-normal text-ink ring-1 ring-inset ring-black/10 outline-none group-data-[focus-within]:ring-2 group-data-[focus-within]:ring-brand group-data-[invalid]:ring-red-500" />
  </AriaTextField>;
}
