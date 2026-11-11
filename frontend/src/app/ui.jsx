// What the views share: the ticket's mode, and "take me there" for the first steps.
import { createContext, useContext } from "react";

export const UiContext = createContext(null);
export const useUi = () => useContext(UiContext);
