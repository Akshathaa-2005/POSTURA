import { useEffect, useState } from "react";
import { loadFormModel, type FormModel } from "@/ml/formModel";

/** The installed form model, or null while loading / if none is installed. Loaded once per page. */
export function useFormModel(): FormModel | null {
  const [model, setModel] = useState<FormModel | null>(null);
  useEffect(() => {
    let live = true;
    loadFormModel().then((m) => live && setModel(m));
    return () => {
      live = false;
    };
  }, []);
  return model;
}
