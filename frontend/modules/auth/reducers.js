import * as accountTypes from "modules/account/types";
import * as types from "./types";

export const initStateAuth = {
    authStep: types.REGISTRATION_STEP_INIT,
    currentForm: types.LOGIN_FORM,
    tempUsername: null,
};

const defaultState = JSON.parse(JSON.stringify(initStateAuth));

const authReducer = (state = defaultState, action) => {
    switch (action.type) {
        case accountTypes.LOGOUT_ACCOUNT:
            return defaultState;
        case types.SET_CURRENT_FORM:
            return { ...state, currentForm: action.payload };
        case types.SET_REGISTRATION_STEP:
            return { ...state, authStep: action.payload };
        case types.SET_TEMP_USERNAME:
            return { ...state, tempUsername: action.payload };
        default:
            return state;
    }
};

export default authReducer;
