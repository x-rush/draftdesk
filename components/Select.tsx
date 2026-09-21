"use client";
import { Children, isValidElement, useEffect, useRef, useState } from "react";
import type { SelectHTMLAttributes, ReactElement, ChangeEvent } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

/** Shared, keyboard accessible picker. Portal stays inside a modal's top layer. */
export function Select({children, value, onChange, className, ...props}: SelectHTMLAttributes<HTMLSelectElement>) {
  const ref = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement>();
  useEffect(() => { setContainer(ref.current?.closest("dialog") || undefined); }, []);
  const options = Children.toArray(children).filter(isValidElement) as ReactElement<{value: string; children: React.ReactNode; disabled?: boolean}>[];
  return <span ref={ref} className={"select-control " + (className || "")}>
    <Primitive.Root value={String(value ?? "")} name={props.name} disabled={props.disabled} required={props.required}
      onValueChange={(next) => onChange?.({target:{value:next}, currentTarget:{value:next}} as ChangeEvent<HTMLSelectElement>)}>
      <Primitive.Trigger className="select-trigger" id={props.id} aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]} aria-describedby={props["aria-describedby"]}>
        <Primitive.Value placeholder="请选择" /><Primitive.Icon><ChevronDown size={16}/></Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal container={container}>
        <Primitive.Content className="select-menu" position="popper" sideOffset={6} collisionPadding={12} onEscapeKeyDown={e => e.stopPropagation()}>
          <Primitive.ScrollUpButton className="select-scroll"><ChevronUp size={16}/></Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-options">
            {options.map(option => <Primitive.Item key={String(option.props.value)} value={String(option.props.value)} disabled={option.props.disabled} className="select-option">
              <Primitive.ItemText>{option.props.children}</Primitive.ItemText><Primitive.ItemIndicator><Check size={16}/></Primitive.ItemIndicator>
            </Primitive.Item>)}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="select-scroll"><ChevronDown size={16}/></Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  </span>;
}
